import { createHash } from 'node:crypto'

export interface DurationReading {
  seconds: number | null
  source: 'hls-extinf' | 'mp4-moov' | 'missing'
  fingerprint: string | null
}

const missing = (): DurationReading => ({ seconds: null, source: 'missing', fingerprint: null })

export function manifestFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function hlsDuration(text: string): DurationReading {
  const lines = text.split(/\r?\n/)
  if (!lines.includes('#EXT-X-ENDLIST')) return missing()
  let total = 0
  let seen = false
  for (const line of lines) {
    if (!line.startsWith('#EXTINF:')) continue
    const value = Number(line.slice(8).split(',')[0])
    if (!Number.isFinite(value) || value <= 0) continue
    total += value
    seen = true
  }
  return seen
    ? { seconds: total, source: 'hls-extinf', fingerprint: manifestFingerprint(text) }
    : missing()
}

export function mp4Duration(head: Buffer): DurationReading {
  const index = head.indexOf(Buffer.from('mvhd', 'ascii'))
  if (index < 4 || index + 8 > head.length) return missing()
  const version = head[index + 4]
  if (version !== 0 && version !== 1) return missing()
  const base = index + 8
  const durationEnd = base + (version === 1 ? 28 : 16)
  if (durationEnd > head.length) return missing()
  const timescale = version === 1 ? head.readUInt32BE(base + 16) : head.readUInt32BE(base + 8)
  const duration = version === 1 ? Number(head.readBigUInt64BE(base + 20)) : head.readUInt32BE(base + 12)
  if (!Number.isFinite(timescale) || timescale <= 0) return missing()
  if (!Number.isFinite(duration) || duration <= 0) return missing()
  return { seconds: duration / timescale, source: 'mp4-moov', fingerprint: null }
}
