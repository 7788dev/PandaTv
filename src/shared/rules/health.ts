import { QUALITIES } from '../../contract/constants'
import type { Quality } from '../../contract/types'
import type { ResolvedHealthConfig } from './config'
import type { FailureCounts, FailureKind, HealthEntry } from './types'

const DAY_MS = 86_400_000

export function failureTotal(failure: FailureCounts): number {
  return failure.catalogue + failure.probe + failure.firstSegment + failure.stall + failure.alignment
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function qualityScore(quality: Quality | null): number {
  if (quality === null) return 0.5
  const index = QUALITIES.indexOf(quality)
  if (index < 0) return 0.5
  return (QUALITIES.length - index) / QUALITIES.length
}

export function scoreOf(entry: HealthEntry, at: number, cfg: ResolvedHealthConfig): number {
  const ageDays = Math.max(0, at - entry.scoredAt) / DAY_MS
  const decay = 0.5 ** (ageDays / cfg.halfLifeDays)
  const availability = (entry.success + 1) / (entry.success + failureTotal(entry.failure) + 2)
  const stability = 1 - clamp01(entry.stallSeconds / Math.max(entry.playSeconds, cfg.playFloorSec))
  const speed = entry.startupMedian === null ? 0.5 : 1 - clamp01(entry.startupMedian / cfg.slowStartupSec)
  const quality = qualityScore(entry.shownQuality)
  const raw = clamp01(
    cfg.weights.availability * availability +
      cfg.weights.stability * stability +
      cfg.weights.speed * speed +
      cfg.weights.quality * quality,
  )
  return clamp01(decay * raw + (1 - decay) * cfg.baseline)
}

export function verdictOf(
  entry: HealthEntry,
  at: number,
  cfg: ResolvedHealthConfig,
): { cooled: boolean; rank: number } {
  const cooled = entry.cooldownUntil !== null && entry.cooldownUntil > at
  return { cooled, rank: cooled ? -1 : scoreOf(entry, at, cfg) }
}

function failureField(kind: FailureKind): keyof FailureCounts {
  return kind === 'first-segment' ? 'firstSegment' : kind
}

export function withFailure(
  entry: HealthEntry,
  kind: FailureKind,
  at: number,
  cfg: ResolvedHealthConfig,
  cooldownSec: number,
): HealthEntry {
  const field = failureField(kind)
  const failure: FailureCounts = { ...entry.failure, [field]: entry.failure[field] + 1 }
  const next: HealthEntry = {
    ...entry,
    failure,
    lastFailureAt: at,
    lastFailureKind: kind,
    cooldownUntil: at + cooldownSec * 1000,
  }
  return { ...next, score: scoreOf(next, at, cfg), scoredAt: at }
}

export function withoutCooldown(entry: HealthEntry, at: number, cfg: ResolvedHealthConfig): HealthEntry {
  return { ...entry, cooldownUntil: null, score: scoreOf(entry, at, cfg), scoredAt: at }
}