import type { ResolvedAlignmentConfig } from './config'
import type {
  DurationHistory,
  DurationInput,
  DurationVerdict,
  FrameSample,
  ScoredSample,
} from './types'

export interface WindowSearchResult {
  readonly offset?: number
  readonly used: number
  readonly reason?: 'over-budget' | 'no-match'
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function usable(values: readonly number[]): number[] {
  return values.filter(value => Number.isFinite(value) && value > 0)
}

export function durationVerdict(
  input: DurationInput,
  history: DurationHistory,
  cfg: ResolvedAlignmentConfig,
): DurationVerdict {
  if (
    input.fromSource === 'missing' ||
    input.toSource === 'missing' ||
    input.fromSeconds === null ||
    input.toSeconds === null
  ) {
    return {
      verdict: 'unknown',
      measured: false,
      ratioDeviation: 0,
      absDeviation: 0,
      basisVersion: cfg.basisVersion,
      reason: 'duration-missing',
    }
  }

  const absDeviation = Math.abs(input.toSeconds - input.fromSeconds)
  const ratioDeviation = absDeviation / Math.max(input.fromSeconds, 1)
  const withinBasis =
    ratioDeviation <= cfg.ratioTolerance || absDeviation <= cfg.absoluteToleranceSec

  const samples = usable(history.sourceSamples)
  const sourceMedian = median(samples)
  const historyInconsistent =
    samples.length >= 2 &&
    sourceMedian > 0 &&
    Math.max(...samples) - Math.min(...samples) > cfg.historyConsistencyRatio * sourceMedian

  const peers = history.workRatios.filter(value => Number.isFinite(value) && value >= 0)
  const peerMedian = median(peers)
  const workOutlier =
    peers.length >= 3 &&
    (peerMedian > 0
      ? ratioDeviation > cfg.workSpreadFactor * peerMedian
      : ratioDeviation > 0)

  const base = {
    measured: true,
    ratioDeviation,
    absDeviation,
    basisVersion: cfg.basisVersion,
  }
  if (historyInconsistent) {
    return { ...base, verdict: 'suspect', reason: 'history-inconsistent' }
  }
  if (workOutlier) return { ...base, verdict: 'suspect', reason: 'work-outlier' }
  return { ...base, verdict: withinBasis ? 'consistent' : 'suspect' }
}

export function pickOffsets(input: DurationInput, cfg: ResolvedAlignmentConfig): number[] {
  if (
    input.fromSource === 'missing' ||
    input.toSource === 'missing' ||
    input.fromSeconds === null ||
    input.toSeconds === null
  ) {
    return [0]
  }
  const delta = input.toSeconds - input.fromSeconds
  const candidates: number[] = []
  for (const value of [0, delta, -delta]) {
    if (!Number.isFinite(value)) continue
    if (!candidates.some(existing => Math.abs(existing - value) < 1e-6)) candidates.push(value)
  }
  return candidates.sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 3)
}

function popCount(value: number): number {
  let count = 0
  let n = value
  while (n !== 0) {
    n &= n - 1
    count += 1
  }
  return count
}

export function similarity(a: FrameSample, b: FrameSample): number {
  if (!a.valid || !b.valid) return 0
  if (a.hash.length === 0 || a.hash.length !== b.hash.length) return 0
  if (a.hash.length % 2 !== 0) return 0
  let distance = 0
  for (let i = 0; i < a.hash.length; i += 2) {
    const left = Number.parseInt(a.hash.slice(i, i + 2), 16)
    const right = Number.parseInt(b.hash.slice(i, i + 2), 16)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
    distance += popCount(left ^ right)
  }
  const bits = (a.hash.length / 2) * 8
  return bits === 0 ? 0 : 1 - distance / bits
}

export function windowSearch(
  anchors: readonly number[],
  samples: readonly ScoredSample[],
  elapsedMs: number,
  cfg: ResolvedAlignmentConfig,
): WindowSearchResult {
  if (elapsedMs > cfg.frameBudgetMs) return { used: 0, reason: 'over-budget' }
  if (anchors.length === 0) return { used: 0, reason: 'no-match' }

  const candidates = samples.filter(
    sample =>
      sample.valid &&
      Number.isFinite(sample.offsetSeconds) &&
      Number.isFinite(sample.similarity) &&
      anchors.some(anchor => Math.abs(sample.offsetSeconds - anchor) <= cfg.windowSeconds),
  )
  if (candidates.length > cfg.sampleLimit) {
    return { used: candidates.length, reason: 'over-budget' }
  }
  if (candidates.length === 0) return { used: 0, reason: 'no-match' }

  const best = [...candidates].sort(
    (a, b) =>
      b.similarity - a.similarity || Math.abs(a.offsetSeconds) - Math.abs(b.offsetSeconds),
  )[0]!
  if (best.similarity < cfg.similarityThreshold) {
    return { used: candidates.length, reason: 'no-match' }
  }
  return { offset: best.offsetSeconds, used: candidates.length }
}