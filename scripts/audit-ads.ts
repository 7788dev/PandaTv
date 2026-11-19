// Re-audits the ad rules against live manifests, through the production matcher and filter.
// Usage: npm run audit:ads            (writes docs/evidence/ad-audit.json)
// For every enabled source and sample title it reports what the shipped rules removed and
// which discontinuity-bounded blocks they left in place, so expired rules (rotated CDN hosts,
// changed ad lengths) and missing rules are visible instead of silently doing nothing.
import { writeFileSync } from 'node:fs'
import type { MediaItem } from '../design/contract/types'
import { filterPlaylist } from '../src/main/playback/filter'
import { getText } from '../src/main/playback/network'
import { manifestVariants, matchesItem, parseLines, searchTerms } from '../src/main/playback/service'
import { loadSourceRules, type PlaySource } from '../src/main/playback/sources'

const SAMPLES: Array<Pick<MediaItem, 'title' | 'year' | 'type'>> = [
  { title: '流浪地球2', year: 2023, type: 'movie' },
  { title: '肖申克的救赎', year: 1994, type: 'movie' },
  { title: '三体', year: 2023, type: 'tv' },
  { title: '漫长的季节', year: 2023, type: 'tv' },
  { title: '庆余年 第二季', year: 2024, type: 'tv' },
  { title: '凡人修仙传', year: 2020, type: 'anime' },
  { title: '向往的生活 第七季', year: 2023, type: 'variety' },
  { title: '舌尖上的中国 第一季', year: 2012, type: 'doc' },
]
/** A block this short between discontinuities is where inserted ads live. */
const SHORT_BLOCK_SECONDS = 60

interface Block { index: number; segments: number; seconds: number; host: string; dir: string; durations: number[]; dropped: boolean; foreign: boolean }
interface Row {
  source: string; title: string; episode: number; ok: boolean; error?: string
  manifestHost?: string; segments?: number; seconds?: number; blocks?: number; encrypted?: boolean
  reason?: string; evidence?: string[]; removedSegments?: number; removedSeconds?: number
  dropped?: Block[]; suspects?: Block[]
}

function blocksOf(text: string, base: URL) {
  const blocks: Array<{ uris: string[]; durations: number[]; host: string; dir: string }> = []
  let duration = 0; let current: (typeof blocks)[number] | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0])
    else if (line === '#EXT-X-DISCONTINUITY') current = undefined
    else if (line && !line.startsWith('#')) {
      const url = new URL(line, base)
      if (!current) { current = { uris: [], durations: [], host: url.hostname, dir: url.pathname.replace(/[^/]*$/, '') }; blocks.push(current) }
      current.uris.push(line); current.durations.push(duration)
    }
  }
  return blocks
}

async function media(url: string): Promise<{ text: string; url: URL }> {
  let current = url
  for (let depth = 0; depth < 4; depth++) {
    const got = await getText(current, { timeoutMs: 15000 })
    if (!got.text.trimStart().startsWith('#EXTM3U')) throw new Error('not an HLS playlist')
    const variants = manifestVariants(got.text, got.url)
    if (!variants.length) return got
    current = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0]!.url
  }
  throw new Error('nested too deep')
}

async function find(source: PlaySource, item: MediaItem) {
  for (const term of searchTerms(item.title)) {
    const url = new URL(source.api); url.searchParams.set('ac', 'videolist'); url.searchParams.set('wd', term)
    const { text } = await getText(url, { timeoutMs: 15000 })
    const rows = (JSON.parse(text) as { list?: Array<Record<string, unknown>> }).list ?? []
    for (const row of rows) {
      if (!matchesItem(item, row)) continue
      let full = row
      if (!row.vod_play_url) {
        const detail = new URL(source.api); detail.searchParams.set('ac', 'videolist'); detail.searchParams.set('ids', String(row.vod_id))
        full = ((JSON.parse((await getText(detail, { timeoutMs: 15000 })).text) as { list?: Array<Record<string, unknown>> }).list ?? []).find(r => String(r.vod_id) === String(row.vod_id)) ?? row
      }
      const line = parseLines(String(full.vod_play_from ?? ''), String(full.vod_play_url ?? '')).find(l => l.episodes.some(e => e.format === 'hls'))
      if (line) return line.episodes.filter(e => e.format === 'hls')
    }
  }
  return undefined
}

async function main() {
  const out = process.argv[2] ?? 'docs/evidence/ad-audit.json'
  const rules = loadSourceRules()
  const rows: Row[] = []
  await Promise.all(rules.sources.filter(source => source.enabled).map(async source => {
    for (const sample of SAMPLES) {
      const item = { id: 'audit', genres: [], ...sample } as unknown as MediaItem
      let episodes
      try { episodes = await find(source, item) } catch (error) { rows.push({ source: source.key, title: sample.title, episode: 0, ok: false, error: 'search: ' + (error as Error).message }); continue }
      if (!episodes?.length) { rows.push({ source: source.key, title: sample.title, episode: 0, ok: false, error: 'not carried' }); continue }
      for (const index of [...new Set([0, Math.floor(episodes.length / 2)])]) {
        const row: Row = { source: source.key, title: sample.title, episode: index + 1, ok: false }
        try {
          const { text, url } = await media(episodes[index]!.url)
          // Dumps carry absolute URLs without query strings: no tokens, replayable as fixtures.
          if (process.env.AUDIT_DUMP) writeFileSync(`${process.env.AUDIT_DUMP}/${source.key}-${sample.title}-${index + 1}.m3u8`, text.split(/\r?\n/).map(raw => {
            const line = raw.trim(); const clean = (uri: string) => { const u = new URL(uri, url); u.search = ''; return u.href }
            return line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${clean(uri)}"`) : line ? clean(line) : ''
          }).join('\n'))
          const before = blocksOf(text, url)
          const result = filterPlaylist(text, url, source, rules)
          const kept = new Set(blocksOf(result.text, url).flatMap(block => block.uris))
          const longest = [...before].sort((a, b) => b.durations.reduce((s, n) => s + n, 0) - a.durations.reduce((s, n) => s + n, 0))[0]
          const described: Block[] = before.map((block, i) => ({
            index: i, segments: block.uris.length, seconds: Number(block.durations.reduce((s, n) => s + n, 0).toFixed(3)), host: block.host, dir: block.dir.replace(/[0-9a-f]{16,}/gi, '…'),
            durations: block.durations.slice(0, 8), dropped: block.uris.every(uri => !kept.has(uri)), foreign: block.host !== longest?.host || block.dir !== longest?.dir,
          }))
          const flat = before.flatMap(block => block.durations)
          Object.assign(row, {
            ok: true, manifestHost: url.hostname, segments: flat.length, seconds: Math.round(flat.reduce((s, n) => s + n, 0)), blocks: before.length,
            encrypted: /#EXT-X-KEY:(?!.*METHOD=NONE)/.test(text), reason: result.reason, evidence: result.evidence, removedSegments: result.removedSegments, removedSeconds: result.removedSeconds,
            dropped: described.filter(block => block.dropped),
            // Left in place although short and bounded by discontinuities: either real content joins or unhandled ads.
            suspects: before.length > 1 ? described.filter(block => !block.dropped && block.seconds <= SHORT_BLOCK_SECONDS) : [],
          } satisfies Partial<Row>)
        } catch (error) { row.error = (error as Error).message }
        rows.push(row)
        console.log(`${row.ok ? 'ok ' : 'ERR'} ${source.key} ${sample.title} #${row.episode} ${row.ok ? `${row.manifestHost} seg=${row.segments} blocks=${row.blocks} ${row.reason}${row.evidence ? '[' + row.evidence.join('+') + ']' : ''} -${row.removedSegments}seg/${row.removedSeconds}s left=${row.suspects!.length}${row.suspects!.some(block => block.foreign) ? ' FOREIGN-LEFT' : ''}${row.encrypted ? ' encrypted' : ''}` : row.error}`)
      }
    }
  }))
  rows.sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title) || a.episode - b.episode)
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rulesVersion: rules.version, verifiedAt: rules.verifiedAt, samples: SAMPLES, rows }, null, 1) + '\n')
  const ok = rows.filter(row => row.ok)
  console.log(`\n${rows.length} rows, ${ok.length} manifests read, ${ok.filter(row => row.removedSegments).length} filtered, ${ok.filter(row => row.suspects?.length).length} with short blocks left in place`)
}
void main()
