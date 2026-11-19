/** Media seconds delivered per wall-clock second, including connection setup. */
export function playbackMargin(seconds: number | undefined, length: number | undefined, received: number, elapsedMs: number, complete: boolean): number | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0 || received <= 0) return undefined
  const fraction = complete ? 1 : length && Number.isFinite(length) && length > 0 ? Math.min(1, received / length) : undefined
  return fraction === undefined ? undefined : seconds * fraction * 1000 / Math.max(1, elapsedMs)
}

export interface DeliveryScore { picture: number; margin?: number }
export const PLAYBACK_HEADROOM = 1.25
const tier = (score: DeliveryScore) => score.margin === undefined ? 1 : score.margin >= PLAYBACK_HEADROOM ? 2 : 0

export interface SourceOrderScore { behind: boolean; previous: boolean; winner: boolean }

/** Keep recent failures last, then reuse the previous winner as a tie-breaker. */
export function compareSourceOrder(a: SourceOrderScore, b: SourceOrderScore, retry = false): number {
  const backoff = Number(a.behind) - Number(b.behind)
  if (backoff) return backoff
  const previous = (Number(b.previous) - Number(a.previous)) * (retry ? -1 : 1)
  if (previous) return previous
  return Number(b.winner) - Number(a.winner)
}

/** Prefer measured headroom, then picture; among underspeed sources prefer speed. */
export function compareDelivery(a: DeliveryScore, b: DeliveryScore): number {
  const band = tier(a) - tier(b)
  if (band) return band
  const speed = (a.margin ?? 0) - (b.margin ?? 0)
  return tier(a) === 0 ? speed || a.picture - b.picture : a.picture - b.picture || speed
}
