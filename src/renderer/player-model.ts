import type { HistoryEntry, Quality } from '../../design/contract/types'
import { isFinished } from '../../design/contract/rules'

export function playbackHistory(id: string, episode: number, position: number, duration: number, hasNext: boolean, at = Date.now()): HistoryEntry | null {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || position < 0) return null
  const progress = { position: Math.min(position, duration), duration }
  // The next episode's length is not known until its own media metadata arrives.
  return hasNext && isFinished(progress)
    ? { id, episode: episode + 1, position: 0, duration: 0, at }
    : { id, episode, position: Math.floor(progress.position), duration, at }
}
export function resolutionQuality(width: number, height: number): Quality | undefined {
  return width >= 3800 || height >= 2100 ? '4K' : width >= 1900 || height >= 1000 ? '1080P' : width >= 1200 || height >= 700 ? '720P' : width >= 600 || height >= 400 ? '480P' : undefined
}
export function bufferedRanges(buffered: TimeRanges, duration: number): { start: number; end: number }[] {
  if (!Number.isFinite(duration) || duration <= 0) return []
  return Array.from({ length: buffered.length }, (_, i) => ({ start: Math.max(0, buffered.start(i)), end: Math.min(duration, buffered.end(i)) })).filter(range => range.end > range.start)
}
