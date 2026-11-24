/**
 * Per-source real playback audit: Douban hot titles → one source forced at a time →
 * catalogue match, episode resolution, manifest/playlist and actual media bytes.
 *
 *   npm run probe:health
 *   npm run probe:health -- 2 tv,zy360
 *
 * The report distinguishes an unreachable/blocked upstream from a source that answers
 * but has no matching title, and from a source that resolves a line whose media is
 * empty or unreadable. Disabled-but-configured sources are measured and labelled.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DoubanDataSource } from '../src/main/data/douban'
import { PlaybackService, type WorkHints } from '../src/main/playback/service'
import { MediaProxy } from '../src/main/playback/proxy'
import { loadSourceRules, type SourceRules } from '../src/main/playback/sources'
import { createTransport } from '../src/main/data/transport'
import { describeEgress } from '../src/main/egress'
import type { MediaItem, MediaType } from '../src/contract/types'

const TYPES: MediaType[] = ['tv', 'movie', 'anime', 'variety']

type Row = {
  type: string
  title: string
  year?: number
  present: string[]
  sourceEpisodes?: number
  format?: string
  quality?: string
  manifestStatus?: number
  manifestBytes?: number
  segmentStatus?: number
  segmentBytes?: number
  midStatus?: number
  midBytes?: number
  error?: string
  failureKind?: string
  ms?: number
}

function kind(message: string): string {
  if (/403|暂不可用|Just a moment|非公开|拒绝|forbidden/i.test(message)) return 'upstream-blocked'
  if (/超时|timed out|timeout|连接.*超时|重置|reset/i.test(message)) return 'upstream-timeout'
  if (/未找到|没有片源|noEpisode|没有可播放|集数/.test(message)) return 'no-match'
  if (/媒体不可用|不支持的播放地址|格式|media/i.test(message)) return 'media-invalid'
  return 'playback-error'
}

async function fetchMedia(url: string, format: string) {
  const response = await fetch(url, {
    headers: format === 'mp4' ? { Range: 'bytes=0-65535' } : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const status = response.status
  if (format === 'mp4') {
    const bytes = (await response.arrayBuffer()).byteLength
    return { status, manifestBytes: bytes, segmentStatus: status, segmentBytes: bytes, midStatus: undefined, midBytes: undefined }
  }
  const text = await response.text()
  const base = new URL(url)
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
  const urls = lines.map(line => { try { return new URL(line, base).toString() } catch { return '' } }).filter(Boolean)
  const first = urls[0]
  if (!first) return { status, manifestBytes: Buffer.byteLength(text), segmentStatus: status, segmentBytes: 0, midStatus: undefined, midBytes: undefined }
  // A master playlist points at a variant playlist; follow one level before reading a segment.
  let segmentUrl = first
  let segmentStatus = 0
  let segmentBytes = 0
  for (let depth = 0; depth < 3; depth++) {
    const sample = await fetch(segmentUrl, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(20_000) })
    segmentStatus = sample.status
    const buffer = new Uint8Array(await sample.arrayBuffer())
    segmentBytes = buffer.byteLength
    if (!sample.headers.get('content-type')?.includes('mpegurl')) break
    const nested = new TextDecoder().decode(buffer).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
    const next = nested.map(line => { try { return new URL(line, segmentUrl).toString() } catch { return '' } }).filter(Boolean)[0]
    if (!next) break
    segmentUrl = next
  }
  let midStatus: number | undefined
  let midBytes: number | undefined
  if (urls.length > 20) {
    const mid = await fetch(urls[Math.floor(urls.length / 2)]!, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(20_000) })
    midStatus = mid.status
    midBytes = (await mid.arrayBuffer()).byteLength
  }
  return { status, manifestBytes: Buffer.byteLength(text), segmentStatus, segmentBytes, midStatus, midBytes }
}

async function main() {
  const perType = Math.max(1, Math.min(10, Number(process.argv[2] ?? 2)))
  const only = process.argv[3]?.split(',').filter(Boolean)
  const output = process.argv[4] ?? join(__dirname, '..', 'docs', 'evidence', 'source-playback-audit-2026-11-24.json')
  const data = new DoubanDataSource({ imageUrl: url => url, onWarning: () => {}, fetch: createTransport() })
  const rules = loadSourceRules()
  const subjects: Array<{ card: MediaItem; item: MediaItem; hints: WorkHints }> = []
  for (const type of TYPES) {
    try {
      const page = await data.channel(type, { sort: 'hot' })
      for (const card of page.items.slice(0, perType)) {
        try {
          const item = await data.subject(card.id)
          const record = data.getMetadata(item.id)
          subjects.push({ card, item, hints: { single: record?.kind === 'movie', aliases: record?.aliases, totalEpisodes: record?.totalEpisodes } })
        } catch (error) {
          console.log(JSON.stringify({ type, title: card.title, metadataError: (error as Error).message }))
        }
      }
    } catch (error) {
      console.log(JSON.stringify({ type, channelError: (error as Error).message }))
    }
  }

  const proxy = new MediaProxy({ rules })
  await proxy.start()
  const report: Record<string, unknown> = {
    at: new Date().toISOString(), route: describeEgress(), perType,
    method: 'Douban hot subject → one source forced at a time → sources() + resolve() → playlist and real segment bytes',
    sources: [] as unknown[],
  }
  const selectedSources = rules.sources.filter(source => !only || only.includes(source.key))
  for (const source of selectedSources) {
    const solo: SourceRules = { ...rules, sources: rules.sources.map(row => ({ ...row, enabled: row.key === source.key })) }
    const failures: string[] = []
    const playback = new PlaybackService({ proxy, rules: solo, onSourceFailure: (key, reason, ms) => { if (key === source.key) failures.push(`${reason} ${ms}ms`) } })
    const rows: Row[] = []
    for (const subject of subjects) {
      const started = Date.now()
      const row: Row = { type: subject.item.type, title: subject.item.title, year: subject.item.year, present: [] }
      try {
        const sources = await playback.sources(subject.item, 1, subject.hints)
        row.present = sources.list.map(entry => entry.key)
        if (!row.present.includes(source.key)) throw new Error('未找到可用片源')
        const availability = await playback.availability(subject.item, subject.hints)
        row.sourceEpisodes = availability.episodes
        const played = await playback.resolve(subject.item, 1, undefined, false, subject.hints)
        row.format = played.format; row.quality = played.quality
        const media = await fetchMedia(played.url, played.format)
        Object.assign(row, media)
        if (!media.segmentBytes) row.error = '媒体分片为空'
      } catch (error) {
        row.error = (error as Error).message
        row.failureKind = kind(row.error!)
      }
      row.ms = Date.now() - started
      rows.push(row)
      console.log(JSON.stringify({ source: source.key, ...row }))
    }
    const playable = rows.filter(row => row.segmentBytes && row.segmentBytes > 0).length
    const present = rows.filter(row => row.present.includes(source.key)).length
    const blocked = rows.filter(row => row.failureKind === 'upstream-blocked' || row.failureKind === 'upstream-timeout').length
    const noMatch = rows.filter(row => row.failureKind === 'no-match').length
    const mediaFailed = rows.filter(row => row.present.includes(source.key) && (!row.segmentBytes || row.segmentBytes <= 0)).length
    const verdict = playable > 0 && mediaFailed === 0 ? 'playable'
      : playable > 0 ? 'partial'
        : present > 0 ? 'catalogue-only-or-media-broken'
          : blocked === rows.length ? 'unreachable'
            : noMatch === rows.length ? 'no-match' : 'failed'
    const summary = {
      key: source.key, name: source.name, configuredEnabled: source.enabled, verdict,
      tests: rows.length, playable, present, blocked, noMatch, mediaFailed,
      failures: [...new Set(failures)].slice(0, 8), rows,
    }
    ;(report.sources as unknown[]).push(summary)
    console.log(JSON.stringify({ summary: { key: source.key, name: source.name, configuredEnabled: source.enabled, verdict, tests: rows.length, playable, present, blocked, noMatch, mediaFailed, failures: summary.failures } }))
  }
  writeFileSync(output, JSON.stringify(report, null, 1) + '\n')
  await proxy.close()
  process.exit(0)
}

void main()