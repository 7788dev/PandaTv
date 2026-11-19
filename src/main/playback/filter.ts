import type { PlaySource, SourceRules } from './sources'

/** What identified a removed block as an injected ad. */
export type Evidence = 'cue' | 'marker' | 'path' | 'fingerprint' | 'foreign'
export interface FilterResult { text: string; removedSegments: number; removedSeconds: number; reason: string; evidence?: Evidence[] }
type Segment = { prefix: string[]; uri: string; url: URL; duration: number; key?: string; boundary: boolean; block: number; evidence?: Evidence }
const preserve = (text: string, reason: string): FilterResult => ({ text, removedSegments: 0, removedSeconds: 0, reason })

/** The content's own directory must carry at least this share for another directory to count as foreign. */
const MAIN_SHARE = 0.8
/** One removed run may never exceed this, whatever the evidence. */
const MAX_RUN_SECONDS = 90
const FINGERPRINT_TOLERANCE = 0.04
const directory = (url: URL) => url.host + url.pathname.replace(/[^/]*$/, '')
const encrypted = (key?: string) => Boolean(key && !/METHOD=NONE/.test(key))

/**
 * Removes injected ad blocks from a VOD media playlist.
 *
 * A block is removed only on evidence that it was spliced in, never because of how it looks:
 *  - cue:         an explicit, closed CUE-OUT … CUE-IN range
 *  - marker:      the CMS's own `# ppvod-ad-injected` comment in front of the block
 *  - path:        a segment path the source reserves for ads (`adPaths` in the rules)
 *  - fingerprint: a discontinuity-bounded block whose segment durations equal a captured ad
 *  - foreign:     a short discontinuity-bounded block stored outside the directory that holds
 *                 the programme (at least 80% of it)
 * Evidence is scoped to the catalogue the manifest was resolved from, not to CDN hostnames:
 * every source rotates through many CDN hosts, so host lists silently stop matching.
 * Anything ambiguous is returned unchanged with the reason.
 */
export function filterPlaylist(text: string, base: URL, source: PlaySource, rules: SourceRules, preserveTimeline = false): FilterResult {
  const original = text.replace(/^﻿/, '')
  const lines = original.split(/\r?\n/).map(line => line.trim())
  if (preserveTimeline) return preserve(original, 'synchronized-tracks')
  const guards: Array<[boolean, string]> = [
    [!lines.includes('#EXT-X-ENDLIST'), 'live-or-master'],
    // Whole-segment AES-128 survives removal (see below); sample encryption and DRM do not.
    [lines.some(l => l.startsWith('#EXT-X-KEY:') && !/METHOD=(?:NONE|AES-128)(?:,|$)/.test(l)), 'encrypted'],
    [lines.some(l => l.startsWith('#EXT-X-SESSION-KEY:')), 'encrypted'],
    [lines.some(l => /^#EXT-X-(?:MEDIA:|STREAM-INF:)/.test(l)), 'master'],
    [lines.some(l => /^#EXT-X-(?:PART|PRELOAD-HINT|SKIP|MAP:)/.test(l)), 'complex-timeline'],
    [lines.some(l => /^#EXT-X-(?:START|PROGRAM-DATE-TIME|DATERANGE|DISCONTINUITY-SEQUENCE):/.test(l)), 'anchored-timeline'],
    [lines.some(l => l.startsWith('#EXT-X-BYTERANGE:')), 'byte-range'],
    [lines.some(l => !l.startsWith('#') && /\.(?:vtt|ttml)(?:\?|$)/i.test(l)), 'subtitles'],
  ]
  for (const [condition, reason] of guards) if (condition) return preserve(original, reason)
  const header: string[] = []; const segments: Segment[] = []; let pending: string[] = []
  let cue = false; let armed = false; let marker = false; let boundary = false; let block = 0; let key: string | undefined
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('# ppvod-ad-injected')) { armed = true; continue }
    if (line === '#EXT-X-DISCONTINUITY') {
      // The marker names the block that the next discontinuity opens, and nothing else.
      marker = armed; armed = false
      boundary = true; block++; pending.push(line); continue
    }
    if (/^#EXT-X-CUE-OUT(?::|$)/.test(line)) { cue = true; continue }
    if (line.startsWith('#EXT-X-CUE-OUT-CONT')) continue
    if (line.startsWith('#EXT-X-CUE-IN')) { cue = false; continue }
    if (line === '#EXT-X-ENDLIST') continue
    // The key is state, not a tag of the next segment: it must survive when that segment is removed.
    if (line.startsWith('#EXT-X-KEY:')) { key = line; continue }
    if (line.startsWith('#')) {
      if (/^#EXT(?:M3U|-X-(?:VERSION|PLAYLIST-TYPE|MEDIA-SEQUENCE|TARGETDURATION|INDEPENDENT-SEGMENTS))/.test(line)) header.push(line)
      else pending.push(line)
      continue
    }
    let url: URL
    try { url = new URL(line, base) } catch { return preserve(original, 'invalid-uri') }
    const durationLine = pending.find(l => l.startsWith('#EXTINF:'))
    const duration = Number(durationLine?.slice(8).split(',')[0])
    if (!Number.isFinite(duration) || duration <= 0) return preserve(original, 'invalid-duration')
    const evidence: Evidence | undefined = cue ? 'cue' : marker ? 'marker' : source.adPaths.some(path => url.pathname.startsWith(path)) ? 'path' : undefined
    segments.push({ prefix: pending, uri: line, url, duration, key, boundary, block, evidence })
    pending = []; boundary = false
  }
  // A cue range that never closes may be the programme itself.
  if (cue) return preserve(original, 'unclosed-ad-break')
  if (segments.length < 3) return preserve(original, 'short-playlist')
  const total = segments.reduce((sum, s) => sum + s.duration, 0)

  for (const fp of source.fingerprints) {
    for (let start = 0; start <= segments.length - fp.length; start++) {
      const end = start + fp.length
      // A captured insert has a discontinuity on both sides; never cross into adjacent content.
      if (!segments[start]!.boundary || (end < segments.length && !segments[end]!.boundary)) continue
      if (fp.every((duration, offset) => Math.abs(segments[start + offset]!.duration - duration) <= FINGERPRINT_TOLERANCE)) {
        for (let i = start; i < end; i++) segments[i]!.evidence ??= 'fingerprint'
      }
    }
  }

  if (rules.foreignBlockMaxSeconds > 0) {
    const blocks = new Map<number, { seconds: number; directories: Set<string> }>()
    const seconds = new Map<string, number>()
    for (const segment of segments) {
      const dir = directory(segment.url)
      const entry = blocks.get(segment.block) ?? { seconds: 0, directories: new Set<string>() }
      entry.seconds += segment.duration; entry.directories.add(dir); blocks.set(segment.block, entry)
      seconds.set(dir, (seconds.get(dir) ?? 0) + segment.duration)
    }
    const [main, mainSeconds] = [...seconds].sort((a, b) => b[1] - a[1])[0]!
    if (blocks.size > 1 && mainSeconds >= total * MAIN_SHARE) {
      for (const segment of segments) {
        const entry = blocks.get(segment.block)!
        if (entry.seconds <= rules.foreignBlockMaxSeconds && !entry.directories.has(main)) segment.evidence ??= 'foreign'
      }
    }
  }

  const dropped = segments.filter(s => s.evidence)
  if (!dropped.length) return preserve(original, 'clean-or-unverified')
  // With an implicit IV every segment is decrypted with its own sequence number, so removing an
  // encrypted segment would renumber the rest. Clear inserts are different: sources number the
  // programme without them (verified by decrypting live segments), so removing them is exact.
  if (dropped.some(s => encrypted(s.key) && !/IV=0x/i.test(s.key!))) return preserve(original, 'encrypted-implicit-iv')
  const removed = dropped.reduce((sum, s) => sum + s.duration, 0)
  if (dropped.length === segments.length || removed > total * rules.maxDropRatio) return preserve(original, 'safety-limit')
  let run = 0
  for (const segment of segments) { run = segment.evidence ? run + segment.duration : 0; if (run > MAX_RUN_SECONDS) return preserve(original, 'ad-block-too-long') }

  const output = [...header]; let removedPending = false; let kept = false; let currentKey: string | undefined
  for (const segment of segments) {
    if (segment.evidence) { removedPending = true; continue }
    if (removedPending && kept && !segment.prefix.includes('#EXT-X-DISCONTINUITY')) output.push('#EXT-X-DISCONTINUITY')
    if (segment.key !== currentKey) { output.push(segment.key ?? '#EXT-X-KEY:METHOD=NONE'); currentKey = segment.key }
    output.push(...segment.prefix, segment.uri); kept = true; removedPending = false
  }
  output.push(...pending, '#EXT-X-ENDLIST', '')
  return {
    text: output.join('\n'), removedSegments: dropped.length, removedSeconds: Number(removed.toFixed(3)), reason: 'filtered',
    evidence: [...new Set(dropped.map(s => s.evidence!))],
  }
}

export function hasSynchronizedTracks(text: string): boolean {
  return text.split(/\r?\n/).some(l => l.startsWith('#EXT-X-MEDIA:') && /TYPE=(?:AUDIO|SUBTITLES)/.test(l) && /URI="/.test(l))
}

/** Every media/variant/key/map URI receives a new capability, never the upstream URL. */
export function rewritePlaylist(text: string, base: URL, register: (url: URL) => string): string {
  const rewrite = (uri: string) => {
    const url = new URL(uri, base)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('播放清单包含不支持的资源协议')
    return register(url)
  }
  return text.replace(/^﻿/, '').split(/\r?\n/).map(raw => {
    const line = raw.trim()
    if (!line) return ''
    if (line.startsWith('#') && !line.startsWith('#EXT')) return ''
    return line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${rewrite(uri)}"`) : rewrite(line)
  }).join('\n')
}
