import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { MediaItem } from '../src/contract/types'
import { MediaProxy } from '../src/main/playback/proxy'
import { PlaybackService } from '../src/main/playback/service'
import { loadSourceRules, type SourceRules } from '../src/main/playback/sources'
import { SourceHealthStore } from '../src/main/health/store'
import { parseRuleCalibration } from '../src/main/health/config'

const transport = vi.hoisted(() => ({ getText: vi.fn(), openPublic: vi.fn() }))
vi.mock(import('../src/main/playback/network'), async original => ({ ...await original(), ...transport }))

const movie: MediaItem = { id: 'db-41', title: '回归影片', type: 'movie', year: 2023, genres: [], poster: null, backdrop: null }
const serial: MediaItem = { ...movie, id: 'db-42', title: '回归剧集', type: 'tv', episodes: 3 }
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
const proxies: MediaProxy[] = []
const responses: PassThrough[] = []
const failures: string[] = []
const healthStores: SourceHealthStore[] = []
const healthDirs: string[] = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function rules(keys = ['a', 'b', 'c']): SourceRules {
  return { ...loadSourceRules(), sources: keys.map((key, i) => ({ key, name: key, api: `https://${key}.catalog.example.org/api`, enabled: true, priority: 20 - i, adPaths: [], fingerprints: [] })) }
}
async function service(keys?: string[], options: Partial<ConstructorParameters<typeof PlaybackService>[0]> = {}) {
  const config = rules(keys)
  const proxy = new MediaProxy({ rules: config })
  await proxy.start()
  proxies.push(proxy)
  return new PlaybackService({ proxy, rules: config, searchGraceMs: 10, betterPictureMs: 20, firstSegmentGraceMs: 100, turnMs: 100, onSourceFailure: (key, reason) => failures.push(`${key}: ${reason}`), ...options })
}
function health() {
  const config = parseRuleCalibration(JSON.parse(readFileSync('resources/rule-calibration.json', 'utf8')))
  const dir = mkdtempSync(join(tmpdir(), 'panda-admission-health-'))
  healthDirs.push(dir)
  const store = new SourceHealthStore(join(dir, 'health.json'), config.health, config.budget)
  healthStores.push(store)
  return store
}
function catalogue(item = movie, format = 'mp4') {
  transport.getText.mockImplementation(async (raw: string) => {
    const url = new URL(raw), source = url.hostname.split('.')[0]
    if (!url.hostname.includes('.catalog.')) {
      const quality = source === 'a' ? '480' : '720'
      return { url, text: url.pathname.endsWith('master.m3u8')
        ? `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=${quality === '480' ? '854x480' : '1280x720'}\nmain.m3u8\n`
        : '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nfirst.ts\n#EXT-X-ENDLIST\n' }
    }
    const entries = item.type === 'movie' ? [`正片$https://${source}.media.example.org/episode-1.${format}`]
      : [1, 2, 3].map(number => `第${number}集$https://${source}.media.example.org/episode-${number}.${format}`)
    return { url, text: JSON.stringify({ pagecount: 1, list: [{ vod_id: 1, vod_name: item.title, vod_year: '2023', type_name: item.type === 'movie' ? '电影' : '电视剧', vod_play_from: format, vod_play_url: entries.join('#') }] }) }
  })
}
function response(url: string, bytes = mp4, type = 'video/mp4', status = 200) {
  const stream = new PassThrough()
  Object.assign(stream, { statusCode: status, complete: true, headers: { 'content-type': type, 'content-length': String(bytes.length) } })
  stream.end(bytes)
  responses.push(stream)
  return { url: new URL(url), response: stream as unknown as IncomingMessage }
}
beforeEach(() => { failures.length = 0; transport.getText.mockReset(); transport.openPublic.mockReset(); catalogue() })
afterEach(async () => {
  for (const stream of responses.splice(0)) stream.destroy()
  await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
  await Promise.all(healthStores.splice(0).map(store => store.close()))
  for (const dir of healthDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('source admission and selection ownership', () => {
  it('excludes only the recorded ad-bearing catalogue edition before taking four candidates', async () => {
    const config = rules(['hongniu'])
    config.sources[0].excludedRecordIds = loadSourceRules().sources.find(source => source.key === 'hongniu')!.excludedRecordIds
    const list = [71759, 71759, 71759, 71759, 99].map(id => ({ vod_id: id, vod_name: movie.title, vod_year: '2023',
      type_name: '电影', vod_play_from: 'mp4', vod_play_url: '正片$https://cdn.example.org/' + id + '.mp4' }))
    transport.getText.mockResolvedValue({ text: JSON.stringify({ list, pagecount: 1 }) })
    transport.openPublic.mockImplementation(async (url: string) => response(url))
    const client = await service(['hongniu'], { rules: config })
    await client.resolve(movie, 1)
    expect(transport.openPublic.mock.calls.map(call => String(call[0]))).toEqual(['https://cdn.example.org/99.mp4'])
  })

  it('keeps rejected and superseded proposals out of the active selection and next episode preference', async () => {
    catalogue(serial)
    transport.openPublic.mockImplementation(async (url: string) => response(url))
    const client = await service(['a', 'b', 'c'])
    await client.resolve(serial, 1, undefined, false, {}, 'a')
    const old = await client.resolve(serial, 1, undefined, false, {}, 'b', undefined, true)
    expect((await client.sources(serial, 1)).current).toBe('a')
    expect((await client.resolve(serial, 2)).sourceKey).toBe('a')
    const latest = await client.resolve(serial, 1, undefined, false, {}, 'c', undefined, true)
    expect(client.acceptSwitch(serial.id, 1, old.selectionId!)).toBe(false)
    expect(client.acceptSwitch(serial.id, 1, latest.selectionId!)).toBe(true)
    expect((await client.sources(serial, 1)).current).toBe('c')
    expect((await client.resolve(serial, 2)).sourceKey).toBe('c')
  })

  it('records startup and stall separately, skipping cooled sources until expiry or an explicit pick', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const archive = health(), client = await service(['a', 'b'], { health: archive })
      transport.openPublic.mockImplementation(async (url: string) => response(url))
      await client.resolve(movie, 1, undefined, false, {}, 'a')
      expect((await client.resolve(movie, 1, undefined, true, {}, undefined, 'probe')).sourceKey).toBe('b')
      now += 31_000
      transport.openPublic.mockClear()
      await expect(client.resolve(movie, 1, undefined, true, {}, undefined, 'stall')).rejects.toThrow()
      expect(transport.openPublic).not.toHaveBeenCalled()
      expect(archive.snapshot().globals).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceKey: 'a', cooled: true, failure: expect.objectContaining({ probe: 1, stall: 0 }) }),
        expect.objectContaining({ sourceKey: 'b', cooled: true, failure: expect.objectContaining({ probe: 0, stall: 1 }) }),
      ]))
      now += 270_000
      expect((await client.resolve(movie, 1, undefined, true)).sourceKey).toBe('a')
      expect((await client.resolve(movie, 1, undefined, false, {}, 'b')).sourceKey).toBe('b')
    } finally { clock.mockRestore() }
  })

  it('records measured durations from media probes for the next alignment', async () => {
    const archive = health(), client = await service(['a'], { health: archive })
    const seconds = [1200, 1400]
    transport.openPublic.mockImplementation(async (url: string) => {
      const mvhd = Buffer.alloc(32)
      mvhd.write('mvhd', 4); mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(seconds.shift()! * 1000, 24)
      return response(url, Buffer.concat([mp4, mvhd]))
    })
    await client.resolve(movie, 1, undefined, false, {}, 'a')
    await client.resolve(movie, 1, undefined, false, {}, 'a')
    expect(archive.durationHistory(movie.id, 1, 'b', 'a').sourceSamples).toEqual([1200, 1400])
  })

  it('rejects empty and JSON MP4 responses, selects the working fallback and closes probes', async () => {
    transport.openPublic.mockImplementation(async (url: string) => response(url, url.includes('a.media') ? Buffer.alloc(0) : url.includes('b.media') ? Buffer.from('{"error":"offline"}') : mp4, url.includes('b.media') ? 'application/json' : 'video/mp4'))
    const client = await service()
    await client.resolve(movie, 1)
    expect((await client.sources(movie, 1)).current).toBe('c')
    expect(transport.openPublic).toHaveBeenCalledTimes(3)
    await delay(1)
    expect(responses.every(stream => stream.destroyed)).toBe(true)
  })

  it('waits for actual MP4 bytes after successful headers and accepts a split 206 header', async () => {
    const stream = new PassThrough()
    Object.assign(stream, { statusCode: 206, headers: { 'content-type': 'application/octet-stream' } })
    responses.push(stream)
    transport.openPublic.mockResolvedValue({ url: 'https://a.media.example.org/episode-1.mp4', response: stream })
    const client = await service(['a'])
    let selected = false
    const pending = client.resolve(movie, 1).then(value => { selected = true; return value })
    await delay(15)
    expect(selected).toBe(false)
    stream.write(mp4.subarray(0, 4))
    await delay(10)
    expect(selected).toBe(false)
    stream.end(mp4.subarray(4))
    expect((await pending).format).toBe('mp4')
    expect((await client.sources(movie, 1)).current).toBe('a')
  })

  it('does not accept non-media bytes even when the server labels them video/mp4', async () => {
    transport.openPublic.mockImplementation(async (url: string) => response(url, Buffer.from('{"error":"not a movie"}')))
    const client = await service(['a'])
    await expect(client.resolve(movie, 1)).rejects.toThrow('片源暂时无法连接')
    expect((await client.sources(movie, 1)).current).toBeUndefined()
  })

  it('admits an MP4 whose opening network block ends inside mvhd', async () => {
    const partial = Buffer.concat([mp4, Buffer.from('000000746d6f6f760000006c6d7668640000000000000000', 'hex')])
    transport.openPublic.mockImplementation(async (url: string) => response(url, partial))
    const client = await service(['a'])
    expect(await client.resolve(movie, 1)).toMatchObject({ format: 'mp4', durationSource: 'missing' })
    expect((await client.sources(movie, 1)).current).toBe('a')
  })

  it('archives a failed probe while the working fallback succeeds', async () => {
    const archive = health()
    transport.openPublic.mockImplementation(async (url: string) => response(url, url.includes('a.media') ? Buffer.from('{}') : mp4))
    const client = await service(['a', 'b'], { health: archive })
    await client.resolve(movie, 1)
    expect(archive.snapshot().globals.find(entry => entry.sourceKey === 'a')).toMatchObject({
      cooled: true, success: 0, failure: { probe: 1, firstSegment: 0 }, lastFailureKind: 'probe',
    })
    expect(archive.snapshot().globals.find(entry => entry.sourceKey === 'b')).toMatchObject({ success: 1, failure: { probe: 0, firstSegment: 0 } })
  })

  it('does not count a complete HLS winner as a failure after its turn elapsed', async () => {
    catalogue(movie, 'm3u8')
    const archive = health()
    const heads = JSON.parse(readFileSync('tv/app/src/test/resources/media-heads.json', 'utf8')).heads as Array<{ source: string; head: string }>
    const head = Buffer.from(heads.find(entry => entry.source === 'generated-1080')!.head, 'base64')
    transport.openPublic.mockImplementation(async (url: string | URL) => { await delay(30); return response(String(url), head, 'video/mp2t') })
    const client = await service(['a'], { health: archive, turnMs: 5 })
    await client.resolve(movie, 1)
    expect(archive.snapshot().globals[0]).toMatchObject({ success: 1, cooled: false, failure: { probe: 0, firstSegment: 0 }, lastFailureKind: null, shownQuality: '1080P' })
    expect(archive.snapshot().globals[0]!.startupMedian).toBeGreaterThan(0)
    expect(archive.snapshot().works[0].scoreDelta).toBeGreaterThan(0)
  })

  it('does not call a previous good source stalled for an unclassified retry', async () => {
    const archive = health()
    const client = await service(['a'], { health: archive })
    transport.openPublic.mockImplementation(async (url: string) => response(url))
    await client.resolve(movie, 1)
    expect((await client.sources(movie, 1)).current).toBe('a')
    await client.resolve(movie, 1, undefined, true)
    expect(archive.snapshot().globals[0]).toMatchObject({ success: 2, failure: { stall: 0 }, lastFailureKind: null })
  })

  it('records first segment download failures separately from probe failures', async () => {
    catalogue(movie, 'm3u8')
    const archive = health()
    const heads = JSON.parse(readFileSync('tv/app/src/test/resources/media-heads.json', 'utf8')).heads as Array<{ source: string; head: string }>
    const head = Buffer.from(heads.find(entry => entry.source === 'generated-1080')!.head, 'base64')
    transport.openPublic.mockImplementation(async (url: string | URL) => {
      const answer = response(String(url), head, 'video/mp2t')
      answer.response.headers['content-length'] = String(head.length + 1)
      return answer
    })
    const client = await service(['a'], { health: archive })
    await expect(client.resolve(movie, 1)).rejects.toThrow('片源暂时无法连接')
    expect(archive.snapshot().globals[0]).toMatchObject({ success: 0, cooled: true, failure: { probe: 0, firstSegment: 1 }, lastFailureKind: 'first-segment' })
  })

  it('records a slow first-byte probe once when a winner cancels it after its turn', async () => {
    const archive = health()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    transport.openPublic.mockImplementation(async (url: string) => {
      if (url.includes('a.media')) await gate
      else await delay(30)
      return response(url)
    })
    const client = await service(['a', 'b'], { health: archive, turnMs: 5 })
    try {
      await client.resolve(movie, 1)
      release()
      await delay(1)
      expect((await client.sources(movie, 1)).current).toBe('b')
      expect(archive.snapshot().globals.find(entry => entry.sourceKey === 'a')).toMatchObject({
        cooled: true, failure: { probe: 1, firstSegment: 0 }, lastFailureKind: 'probe',
      })
      expect(archive.snapshot().globals.find(entry => entry.sourceKey === 'b')).toMatchObject({
        cooled: false, success: 1, failure: { probe: 0, firstSegment: 0 },
      })
    } finally { release() }
  })

  it('keeps the newer automatic winner when an older automatic request finishes late', async () => {
    let release!: () => void
    const oldGate = new Promise<void>(resolve => { release = resolve })
    const calls = { a: 0, b: 0 }
    transport.openPublic.mockImplementation(async (url: string) => {
      const key = new URL(url).hostname[0] as 'a' | 'b', n = ++calls[key]
      if (key === 'a' && n === 1) await oldGate
      else if ((key === 'a' && n === 2) || (key === 'b' && n === 1)) throw new Error('媒体不可用')
      return response(url)
    })
    const client = await service(['a', 'b'])
    const old = client.resolve(movie, 1)
    while (calls.a + calls.b < 2) await delay(2)
    try {
      const current = await client.resolve(movie, 1, undefined, true)
      expect((await client.sources(movie, 1)).current).toBe('b')
      release()
      expect((await old).url).not.toBe(current.url)
      expect((await client.sources(movie, 1)).current).toBe('b')
      expect((await client.resolve(movie, 1)).url).toBe(current.url)
    } finally { release(); await old }
  })

  it('does not let a late manual request replace a newer automatic fallback', async () => {
    catalogue(serial)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let firstStarted = false, aCalls = 0
    transport.openPublic.mockImplementation(async (url: string) => {
      if (url.includes('a.media')) {
        if (++aCalls === 1) { firstStarted = true; await gate }
        else throw new Error('媒体不可用')
      }
      return response(url)
    })
    const client = await service(['a', 'b'])
    const old = client.resolve(serial, 1, undefined, false, {}, 'a')
    while (!firstStarted) await delay(2)
    try {
      await client.resolve(serial, 1, undefined, true)
      release(); await old
      expect((await client.sources(serial, 1)).current).toBe('b')
      const next = await client.resolve(serial, 2)
      expect(next.format).toBe('mp4')
      expect((await client.sources(serial, 2)).current).toBe('b')
    } finally { release(); await old }
  })

  it('preserves a successful manual preference and invalidates the preloaded next episode', async () => {
    catalogue(serial)
    let preparing = true
    transport.openPublic.mockImplementation(async (url: string) => {
      if (preparing && url.includes('a.media')) throw new Error('媒体不可用')
      return response(url)
    })
    const client = await service(['a', 'b'])
    await client.resolve(serial, 2)
    expect((await client.sources(serial, 2)).current).toBe('b')
    preparing = false
    await client.resolve(serial, 1, undefined, false, {}, 'a')
    const callsBefore = transport.openPublic.mock.calls.length
    await client.resolve(serial, 2)
    expect((await client.sources(serial, 2)).current).toBe('a')
    expect(transport.openPublic.mock.calls.slice(callsBefore).every(([url]) => String(url).includes('a.media'))).toBe(true)
  })

  it('selects the actual better HLS picture rather than the first low-quality response', async () => {
    catalogue(movie, 'm3u8')
    const heads = JSON.parse(readFileSync('tv/app/src/test/resources/media-heads.json', 'utf8')).heads as Array<{ source: string; head: string }>
    transport.openPublic.mockImplementation(async (raw: string | URL) => {
      const url = String(raw)
      const high = url.includes('b.media')
      if (high) await delay(15)
      const sample = heads.find(head => head.source === (high ? 'generated-720' : 'generated-480'))!
      return response(url, Buffer.from(sample.head, 'base64'), 'video/mp2t')
    })
    const client = await service(['a', 'b'])
    const picked = await client.resolve(movie, 1, '720P').catch(error => { throw new Error(`${error.message}; ${failures.join(' | ')}`) })
    expect(picked.quality).toBe('720P')
    expect((await client.sources(movie, 1)).current).toBe('b')
  })

  it('rejects invalid episode numbers before requesting a catalogue', async () => {
    const client = await service()
    await expect(client.resolve(movie, 0)).rejects.toThrow('集数无效')
    await expect(client.resolve(movie, 10001)).rejects.toThrow('集数无效')
    expect(transport.getText).not.toHaveBeenCalled()
  })

  it('admits the correct adaptation and regular episode while a failed mirror falls back to its other address', async () => {
    const item = { ...serial, title: '三体', region: '中国大陆' }
    transport.getText.mockImplementation(async (raw: string) => ({ url: new URL(raw), text: JSON.stringify({ pagecount: 1, list: [
      { vod_id: 2, vod_name: '三体第一季', vod_year: '2023–', vod_area: '美国', type_name: '欧美剧', vod_play_from: 'mp4',
        vod_play_url: Array.from({ length: 8 }, (_, i) => `第${i + 1}集$https://a.media.example.org/remake-${i + 1}.mp4`).join('#') },
      { vod_id: 1, vod_name: '三体', vod_year: '2023', vod_area: '中国大陆', type_name: '国产剧', vod_play_from: 'mp4',
        vod_play_url: ['彩蛋$https://a.media.example.org/bonus.mp4', '第1集$https://a.media.example.org/primary-1.mp4',
          '第1集$https://a.media.example.org/mirror-1.mp4', ...Array.from({ length: 29 }, (_, i) => `第${i + 2}集$https://a.media.example.org/primary-${i + 2}.mp4`)].join('#') },
    ] }) }))
    transport.openPublic.mockImplementation(async (url: string) => response(url, url.includes('primary-1.') ? Buffer.from('{"error":"offline"}') : mp4))
    const client = await service(['a'])
    expect((await client.availability(item)).episodes).toBe(30)
    await client.resolve(item, 1)
    const requested = transport.openPublic.mock.calls.map(([url]) => String(url))
    expect(requested.sort()).toEqual(['https://a.media.example.org/mirror-1.mp4', 'https://a.media.example.org/primary-1.mp4'])
    expect((await client.sources(item, 1)).current).toBe('a')
  })

  it('includes production region in the candidate cache identity', async () => {
    const item = { ...serial, title: '三体', region: '中国大陆' }
    transport.getText.mockImplementation(async (raw: string) => ({ url: new URL(raw), text: JSON.stringify({ pagecount: 1, list: [
      { vod_id: 1, vod_name: '三体', vod_year: '2023', vod_area: '中国大陆', type_name: '国产剧', vod_play_from: 'mp4', vod_play_url: '第1集$https://a.media.example.org/cn-1.mp4#第2集$https://a.media.example.org/cn-2.mp4' },
      { vod_id: 2, vod_name: '三体', vod_year: '2023', vod_area: '美国', type_name: '欧美剧', vod_play_from: 'mp4', vod_play_url: '第1集$https://a.media.example.org/us-1.mp4#第2集$https://a.media.example.org/us-2.mp4#第3集$https://a.media.example.org/us-3.mp4' },
    ] }) }))
    const client = await service(['a'])
    transport.openPublic.mockImplementation(async (url: string) => response(url))
    expect((await client.availability(item)).episodes).toBe(2)
    const chinese = await client.resolve(item, 1)
    expect((await client.availability({ ...item, region: '美国' })).episodes).toBe(3)
    const american = await client.resolve({ ...item, region: '美国' }, 1)
    expect(american.url).not.toBe(chinese.url)
    expect(transport.openPublic.mock.calls.map(([url]) => String(url))).toEqual(['https://a.media.example.org/cn-1.mp4', 'https://a.media.example.org/us-1.mp4'])
    expect(transport.getText).toHaveBeenCalledTimes(2)
  })

  it('a cached quality cannot restore an old playback while leaving the newer source selected', async () => {
    catalogue(movie, 'm3u8')
    const heads = JSON.parse(readFileSync('tv/app/src/test/resources/media-heads.json', 'utf8')).heads as Array<{ source: string; head: string }>
    const requests: string[] = []
    transport.openPublic.mockImplementation(async (raw: string | URL) => {
      const url = String(raw), high = url.includes('b.media')
      requests.push(high ? 'b' : 'a')
      if (high) await delay(15)
      const sample = heads.find(head => head.source === (high ? 'generated-720' : 'generated-480'))!
      return response(url, Buffer.from(sample.head, 'base64'), 'video/mp2t')
    })
    const client = await service(['a', 'b'])
    await client.resolve(movie, 1, '480P')
    expect((await client.sources(movie, 1)).current).toBe('a')
    await client.resolve(movie, 1, '720P')
    expect((await client.sources(movie, 1)).current).toBe('b')
    const before = requests.length
    await client.resolve(movie, 1, '480P')
    expect((await client.sources(movie, 1)).current).toBe('a')
    expect(requests.length).toBeGreaterThan(before)
    const cached = requests.length
    await client.resolve(movie, 1, '480P')
    expect(requests.length).toBe(cached)
  })
})
