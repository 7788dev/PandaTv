import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterPlaylist, hasSynchronizedTracks, rewritePlaylist } from '../src/main/playback/filter'
import { isPublicAddress, validatePublicUrl } from '../src/main/playback/network'
import { isDoubanImage, MediaProxy, normalizeRange } from '../src/main/playback/proxy'
import { matchesItem, parseLines, manifestVariants } from '../src/main/playback/service'
import { loadSourceRules, resolveSourceRules, validateSourceRules } from '../src/main/playback/sources'
import type { MediaItem } from '../design/contract/types'

const rules = loadSourceRules()
const source = (key: string) => rules.sources.find(s => s.key === key)!
const fixture = (name: string) => readFileSync(new URL(`../docs/evidence/manifest-${name}.m3u8`, import.meta.url), 'utf8')
const base = new URL('https://vip.ffzy-online2.com/main.m3u8')
const item: MediaItem = { id: 'db-123', title: '凡人修仙传', year: 2020, type: 'anime', poster: null, backdrop: null, genres: [] }
const vod = (rows: Array<[number, string]>) => '#EXTM3U\n#EXT-X-TARGETDURATION:60\n' + rows.map(([d,u]) => `#EXTINF:${d},\n${u}\n`).join('') + '#EXT-X-ENDLIST\n'

/** Builds a VOD media playlist from tag lines and [seconds, uri] segments. */
const playlist = (...parts: Array<string | [number, string]>) => '#EXTM3U\n#EXT-X-TARGETDURATION:60\n' + parts.map(part => typeof part === 'string' ? part + '\n' : `#EXTINF:${part[0]},\n${part[1]}\n`).join('') + '#EXT-X-ENDLIST\n'
const uris = (text: string) => text.split('\n').filter(line => line && !line.startsWith('#'))
const sourceOf = (file: string) => source(file.replace(/-\d+$/, ''))
const D = '#EXT-X-DISCONTINUITY'

describe('ad evidence on captured manifests', () => {
  it.each([
    ['dyttzy-0', 18, 'fingerprint'], ['dyttzy-1', 5, 'fingerprint'], ['dyttzy-2', 9, 'fingerprint'], ['dyttzy-3', 18, 'fingerprint'],
    ['ffzy-0', 18, 'fingerprint'], ['ffzy-1', 5, 'fingerprint'], ['ffzy-2', 9, 'fingerprint'],
    ['lzi-0', 21, 'marker'], ['lzi-1', 14, 'marker'], ['lzi-2', 14, 'marker'],
    ['bfzy-0', 27, 'path'], ['bfzy-1', 9, 'path'], ['bfzy-2', 9, 'marker'], ['bfzy-3', 18, 'path'], ['bfzy-4', 18, 'marker'],
    ['360zy-0', 40, 'foreign'], ['360zy-1', 8, 'foreign'], ['360zy-2', 12, 'foreign'], ['360zy-3', 28, 'foreign'],
  ] as const)('removes only the inserted blocks from %s', (file, count, evidence) => {
    const original = fixture(file)
    const result = filterPlaylist(original, base, sourceOf(file), rules)
    expect(result.reason).toBe('filtered')
    expect(result.removedSegments).toBe(count)
    expect(result.evidence).toEqual([evidence])
    const before = uris(original), after = uris(result.text)
    expect(after).toHaveLength(before.length - count)
    // What is kept is the original programme, in order.
    let at = 0
    for (const uri of after) { at = before.indexOf(uri, at) + 1; expect(at).toBeGreaterThan(0) }
    expect(result.text.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true)
    expect(result.text).not.toContain('ppvod')
    if (evidence === 'path') expect(after.some(uri => uri.includes('/video/adjump/'))).toBe(false)
  })
  it.each(['jyzy-0', 'jyzy-1', 'jszy-0', 'jszy-1', 'piaoling2-0', 'piaoling2-1', 'lzi-3'])('leaves %s, which carries no evidence, untouched', file => {
    const original = fixture(file)
    const result = filterPlaylist(original, base, sourceOf(file), rules)
    expect(result.removedSegments).toBe(0)
    expect(result.text).toBe(original)
  })
  it('follows a source to whichever CDN host it rotates to', () => {
    // Host lists went stale within weeks; evidence is the structure of the manifest instead.
    const moved = fixture('ffzy-1').replaceAll('vip.ffzy-play9.com', 'vip.ffzy-play37.com')
    expect(filterPlaylist(moved, base, source('ffzy'), rules).removedSegments).toBe(5)
  })
  it('keeps every programme segment under its own key when clear inserts are cut out', () => {
    const keyed = (text: string) => {
      const map = new Map<string, string>(); let key = 'none'
      for (const line of text.split('\n')) { if (line.startsWith('#EXT-X-KEY:')) key = line; else if (line && !line.startsWith('#')) map.set(line, key) }
      return map
    }
    // bfzy-3 uses implicit IVs, bfzy-4 and 360zy-2 explicit ones; in all three the inserts are unencrypted.
    for (const file of ['bfzy-3', 'bfzy-4', '360zy-2']) {
      const original = fixture(file)
      const before = keyed(original), after = keyed(filterPlaylist(original, base, sourceOf(file), rules).text)
      expect(after.size).toBeGreaterThan(100)
      for (const [uri, key] of after) expect(key, uri).toBe(before.get(uri))
      expect([...after.values()].every(key => key.includes('METHOD=AES-128'))).toBe(true)
    }
  })
})

describe('ad evidence boundaries', () => {
  const content = (dir: string, count: number, from = 0): Array<[number, string]> => Array.from({ length: count }, (_, i) => [10, `https://cdn.example/${dir}/${from + i}.ts`])
  it('does not treat repetition, short blocks or ad-looking names as evidence', () => {
    const flat = vod([[60, 'content/a.ts'], [3, 'content/loop.ts'], [3, 'content/loop.ts'], [3, 'promo/trailer.ts'], [3, 'ad/ab.ts'], [3, 'gg/01.ts'], [60, 'content/b.ts']])
    expect(filterPlaylist(flat, base, source('ffzy'), rules).text).toBe(flat)
    // A short block between discontinuities in the programme's own directory is the programme.
    const own = playlist(...content('show', 20), D, [4, 'https://cdn.example/show/x1.ts'], [4, 'https://cdn.example/show/x2.ts'], D, ...content('show', 20, 20))
    for (const key of ['dyttzy', 'ffzy', 'lzi', 'bfzy', '360zy']) expect(filterPlaylist(own, base, source(key), rules).text).toBe(own)
  })
  it('calls a block foreign only when one directory clearly holds the programme', () => {
    const insert: Array<[number, string]> = [[5, 'https://ads.example/x/1.ts'], [5, 'https://ads.example/x/2.ts']]
    const clear = playlist(...content('show', 20), D, ...insert, D, ...content('show', 20, 20))
    expect(filterPlaylist(clear, base, source('360zy'), rules)).toMatchObject({ reason: 'filtered', removedSegments: 2, evidence: ['foreign'] })
    // Two halves on two CDNs: neither is the programme's "own" directory.
    const halves = playlist(...content('part1', 20), D, ...content('part2', 20))
    expect(filterPlaylist(halves, base, source('360zy'), rules).text).toBe(halves)
    // The programme is spread over directories (main share below 80%): a short block is not judged.
    const spread = playlist(...content('part1', 14), D, ...insert, D, ...content('part2', 6))
    expect(filterPlaylist(spread, base, source('360zy'), rules).text).toBe(spread)
    // Longer than an insert: an out-of-directory block above the limit stays.
    const long = playlist(...content('show', 60), D, ...content('other', 7), D, ...content('show', 60, 60))
    expect(filterPlaylist(long, base, source('360zy'), rules).text).toBe(long)
    expect(filterPlaylist(clear, base, source('360zy'), { ...rules, foreignBlockMaxSeconds: 0 }).text).toBe(clear)
  })
  it('scopes fingerprints to their source and needs a discontinuity on both sides', () => {
    expect(filterPlaylist(fixture('ffzy-1'), base, source('dyttzy'), rules).removedSegments).toBe(0)
    const unbounded = fixture('ffzy-1').replaceAll(D + '\n', '')
    expect(filterPlaylist(unbounded, base, source('ffzy'), rules).removedSegments).toBe(0)
  })
  it('applies a marker to the one block the next discontinuity opens', () => {
    const marked = playlist(...content('show', 20), '# ppvod-ad-injected v1', D, [4, 'https://cdn.example/show/ad1.ts'], [4, 'https://cdn.example/show/ad2.ts'], D, ...content('show', 20, 20))
    const result = filterPlaylist(marked, base, source('jyzy'), rules)
    expect(result).toMatchObject({ reason: 'filtered', removedSegments: 2, evidence: ['marker'] })
    expect(uris(result.text)).toEqual(content('show', 40).map(([, uri]) => uri))
    // A marker that no discontinuity follows names nothing.
    const stray = playlist(...content('show', 20), '# ppvod-ad-injected v1', ...content('show', 20, 20))
    expect(filterPlaylist(stray, base, source('jyzy'), rules).removedSegments).toBe(0)
  })
  it('never renumbers an implicit-IV programme: an encrypted insert without an IV stays', () => {
    const key = (iv: string) => `#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/show/key.bin"${iv}`
    const build = (iv: string) => playlist(key(iv), ...content('show', 20), D, [5, 'https://ads.example/x/1.ts'], [5, 'https://ads.example/x/2.ts'], D, ...content('show', 20, 20))
    const implicit = build('')
    expect(filterPlaylist(implicit, base, source('360zy'), rules)).toMatchObject({ reason: 'encrypted-implicit-iv', text: implicit })
    expect(filterPlaylist(build(',IV=0x00000000000000000000000000000000'), base, source('360zy'), rules).removedSegments).toBe(2)
  })
  it('guards how much may be removed', () => {
    expect(filterPlaylist(fixture('ffzy-1'), base, source('ffzy'), { ...rules, maxDropRatio: 0.001 })).toMatchObject({ reason: 'safety-limit', removedSegments: 0 })
    const huge = playlist(...content('show', 100), '# ppvod-ad-injected v1', D, ...content('ads', 10), D, ...content('show', 100, 100))
    expect(filterPlaylist(huge, base, source('lzi'), rules)).toMatchObject({ reason: 'ad-block-too-long', text: huge })
    const allAds = playlist('#EXT-X-CUE-OUT:30', ...content('show', 3), '#EXT-X-CUE-IN')
    expect(filterPlaylist(allAds, base, source('lzi'), rules).removedSegments).toBe(0)
  })
  it('preserves live, byte-range, mapped, anchored, DRM, invalid and unclosed timelines', () => {
    const original = fixture('ffzy-1')
    for (const text of [
      original.replace('#EXT-X-ENDLIST', ''), original.replace('#EXTM3U', '#EXTM3U\n#EXT-X-BYTERANGE:10'), original.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MAP:URI="a.mp4"'),
      original.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"'), original.replace('#EXTM3U', '#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z'),
      original.replace('#EXTINF:', '\n#EXTINF:NaN'), original.replace('#EXT-X-ENDLIST', '#EXT-X-CUE-OUT:5\n#EXT-X-ENDLIST'),
    ]) expect(filterPlaylist(text, base, source('ffzy'), rules).removedSegments).toBe(0)
    expect(filterPlaylist(original, base, source('ffzy'), rules, true).text).toBe(original)
  })
  it('accepts only ad paths that name whole directory levels', () => {
    const withPaths = (adPaths: unknown) => ({ ...rules, sources: [{ ...source('bfzy'), adPaths }] })
    expect(validateSourceRules(withPaths(['/video/adjump/'])).sources[0]!.adPaths).toEqual(['/video/adjump/'])
    for (const bad of [['/'], ['/video/'], ['video/adjump/'], ['/video/adjump'], ['/video/../x/'], 'adjump', undefined]) expect(() => validateSourceRules(withPaths(bad))).toThrow()
    expect(() => validateSourceRules({ ...rules, foreignBlockMaxSeconds: 600 })).toThrow()
  })
  it('takes a newer valid rules file from user data and falls back to the bundled one otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panda-rules-'))
    const file = join(dir, 'play-sources.json')
    const reports: string[] = []
    expect(resolveSourceRules(file, message => reports.push(message))).toEqual(rules)
    expect(reports).toEqual([])
    writeFileSync(file, JSON.stringify({ ...rules, version: rules.version + 1, sources: rules.sources.map(s => s.key === 'ffzy' ? { ...s, fingerprints: [[1, 2, 3, 4]] } : s) }))
    const custom = resolveSourceRules(file, message => reports.push(message))
    expect(custom.version).toBe(rules.version + 1)
    expect(custom.sources.find(s => s.key === 'ffzy')!.fingerprints).toEqual([[1, 2, 3, 4]])
    writeFileSync(file, JSON.stringify({ ...rules, version: rules.version - 1 }))
    expect(resolveSourceRules(file, message => reports.push(message))).toEqual(rules)
    writeFileSync(file, JSON.stringify({ ...rules, version: rules.version + 1, sources: [{ ...rules.sources[0], api: 'http://192.168.1.1/api' }] }))
    expect(resolveSourceRules(file, message => reports.push(message))).toEqual(rules)
    writeFileSync(file, '{ not json')
    expect(resolveSourceRules(file, message => reports.push(message))).toEqual(rules)
    expect(reports.map(message => message.split(' ').slice(0, 3).join(' '))).toEqual([`rules override v${rules.version + 1}`, `rules override v${rules.version - 1}`, 'rules override rejected:', 'rules override rejected:'])
  })
  it('rewrites every child, key, and map without exposing upstream URLs', () => {
    const original = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?secret=1"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=10\nrelative/index.m3u8\n'
    const targets: string[] = []
    const text = rewritePlaylist(original, base, url => { targets.push(url.href); return `/asset/id-${targets.length}` })
    expect(targets).toHaveLength(3)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('https://')
    expect(text).toContain('URI="/asset/id-1"')
    expect(hasSynchronizedTracks('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"')).toBe(true)
  })
})

describe('CMS identity and source boundaries', () => {
  it('rejects same-name live action, a different year, sequel and ignored search query', () => {
    expect(matchesItem(item,{vod_name:item.title,vod_year:2020,type_name:'国产动漫'})).toBe(true)
    expect(matchesItem(item,{vod_name:item.title,vod_year:2025,type_name:'国产剧'})).toBe(false)
    expect(matchesItem(item,{vod_name:'凡人修仙传 慕兰之战',vod_year:2026,type_name:'国产动漫'})).toBe(false)
    expect(matchesItem(item,{vod_name:'其他电影',vod_year:2020,type_name:'电影'})).toBe(false)
    expect(matchesItem(item,{vod_name:'凡人修仙传解说',vod_year:2020,type_name:'电影解说'})).toBe(false)
  })
  it('keeps real labels and direct HLS/MP4 while rejecting player pages and trailers', () => {
    const lines = parseLines('yun$$$m3u8','第01集$https://example.com/player.html$$$第01集$https://example.com/1.m3u8#第02集$https://example.com/2.mp4#预告$https://example.com/trailer.mp4')
    expect(lines).toHaveLength(1); expect(lines[0].episodes).toHaveLength(2)
    expect(lines[0].episodes[0].number).toBe(1)
    expect(lines[0].episodes[1].format).toBe('mp4')
  })
  it('only reports qualities from real variant resolution tags', () => {
    expect(manifestVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080.m3u8',base)[0]).toMatchObject({ quality: '1080P', bandwidth: 2_000_000 })
    expect(manifestVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvideo.m3u8',base)[0].quality).toBeUndefined()
  })
  it('skips one malformed or non-http variant instead of losing the whole master', () => {
    const variants = manifestVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttp://[bad\n#EXT-X-STREAM-INF:BANDWIDTH=2000\njavascript:alert(1)\n#EXT-X-STREAM-INF:BANDWIDTH=3000,RESOLUTION=1920x1080\n1080.m3u8', base)
    expect(variants).toHaveLength(1)
    expect(variants[0]!.quality).toBe('1080P')
    expect(variants[0]!.url).toBe('https://vip.ffzy-online2.com/1080.m3u8')
  })
  it('rejects private targets, credential URLs, malicious ports and bad source configuration', () => {
    for (const url of ['http://127.0.0.1/a','http://[::1]/','http://[::ffff:127.0.0.1]/','http://169.254.169.254/','http://192.168.1.2/','http://example.com:25/','https://example.com:22/','http://example.com:993/','http://example.com:6667/','http://example.com:10080/','http://example.com:5060/','file:///test','https://user:password@example.com/']) expect(() => validatePublicUrl(url)).toThrow()
    // Media CDNs serve HLS on ports of their own, as browsers allow; observed 2026-11-16: c.baisiweiting.com:18443, 2026-11-17: hnts.ymuuy.com:65.
    for (const url of ['https://c.baisiweiting.com:18443/hls/1.ts','https://hnts.ymuuy.com:65/hls/plist0.ts','http://example.com:8080/a.m3u8','https://example.com:443/','http://example.com:80/']) expect(validatePublicUrl(url).hostname).toBeTruthy()
    expect(isPublicAddress('8.8.8.8')).toBe(true); expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(isDoubanImage(new URL('https://img1.doubanio.com/a.jpg'))).toBe(true)
    expect(isDoubanImage(new URL('https://doubanio.com.attacker.com/a.jpg'))).toBe(false)
    expect(() => validateSourceRules({...rules,maxDropRatio:0.8})).toThrow()
    expect(source('jszy').enabled).toBe(false)
  })
  it('keeps exact valid Range semantics', () => {
    expect(normalizeRange('bytes=100-500')).toBe('bytes=100-500')
    expect(normalizeRange('bytes=100-')).toBe('bytes=100-')
    expect(() => normalizeRange('bytes=10-5')).toThrow()
    expect(() => normalizeRange('bytes=0-4,8-12')).toThrow()
  })
  it('exposes only opaque local capabilities and denies unknown tokens', async () => {
    const proxy = new MediaProxy({rules}); await proxy.start()
    try {
      const url = proxy.registerMedia('https://example.com/film.m3u8?secret=private', source('ffzy'))
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/asset\/[a-f0-9]{48}$/)
      expect(url).not.toContain('secret'); expect(url).not.toContain('example.com')
      const response = await fetch(url.replace(/asset\/.+$/, 'asset/'+'0'.repeat(48)))
      expect(response.status).toBe(404)
    } finally { await proxy.close() }
  })
})
