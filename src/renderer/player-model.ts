import type { HistoryEntry, Quality } from '../contract/types'
import { historyRecord } from '../contract/rules'

export function playbackHistory(id: string, episode: number, position: number, duration: number, next: number | boolean | undefined, at = Date.now()): HistoryEntry | null {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || position < 0) return null
  return { ...historyRecord(id, episode, Math.min(position, duration), duration, next), at }
}
export function resolutionQuality(width: number, height: number): Quality | undefined {
  return width >= 3800 || height >= 2100 ? '4K' : width >= 1900 || height >= 1000 ? '1080P' : width >= 1200 || height >= 700 ? '720P' : width >= 600 || height >= 400 ? '480P' : undefined
}
export function bufferedRanges(buffered: TimeRanges, duration: number): { start: number; end: number }[] {
  if (!Number.isFinite(duration) || duration <= 0) return []
  return Array.from({ length: buffered.length }, (_, i) => ({ start: Math.max(0, buffered.start(i)), end: Math.min(duration, buffered.end(i)) })).filter(range => range.end > range.start)
}
/** Only the range containing the playhead can supply the next frame. */
export function playbackBuffer(buffered: TimeRanges, position: number, duration: number) {
  for (let i = 0; i < buffered.length; i++) {
    const end = buffered.end(i)
    if (buffered.start(i) <= position && position <= end) {
      // Media tracks can end a fraction of a frame apart.
      return { ahead: end - position, bufferedToEnd: Number.isFinite(duration) && duration > 0 && end >= duration - 0.05 }
    }
  }
  return { ahead: 0, bufferedToEnd: false }
}

/** Position when the media actually moved; undefined while it stands still or is seeking. */
export function playbackProgress(previous: number, current: number, seeking: boolean): number | undefined {
  if (seeking || !Number.isFinite(current) || current < 0) return undefined
  if (!Number.isFinite(previous) || previous < 0) return current
  return Math.abs(current - previous) > 0.05 ? current : undefined
}

/** The highest-bitrate level carrying the requested picture, or undefined where the source lacks it. */
export function qualityLevelIndex(levels: Array<{ quality?: Quality; index: number; bitrate?: number }>, target: Quality | undefined): number | undefined {
  if (!target) return undefined
  const matches = levels.filter(level => level.quality === target)
  if (!matches.length) return undefined
  return matches.reduce((best, level) => (level.bitrate ?? 0) > (best.bitrate ?? 0) ? level : best).index
}
