export interface HealthRank {
  readonly cooled: boolean
  readonly rank: number
}

export function compareHealthRank(a: HealthRank, b: HealthRank): number {
  const cooled = Number(a.cooled) - Number(b.cooled)
  if (cooled) return cooled
  return b.rank - a.rank
}

export function combineWorkDelta(score: number, delta: number, max: number): number {
  const bounded = Math.max(-max, Math.min(max, Number.isFinite(delta) ? delta : 0))
  return Math.max(0, Math.min(1, score * (1 + bounded)))
}

export function sessionScore(score: number, playSeconds: number, stallSeconds: number): number {
  if (!(playSeconds > 0) || !(stallSeconds > 0)) return score
  const stability = 1 - Math.min(1, stallSeconds / playSeconds)
  return Math.max(0, Math.min(1, score * (0.5 + 0.5 * stability)))
}