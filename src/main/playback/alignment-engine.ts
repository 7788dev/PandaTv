import type { ResolvedAlignmentConfig } from '../../shared/rules/config'
import type {
  AlignEndpoint,
  AlignmentReason,
  AlignmentResult,
  DurationHistory,
  DurationInput,
  ScoredSample,
} from '../../shared/rules/types'
import { durationVerdict, pickOffsets, windowSearch } from '../../shared/rules/alignment'
import type { OffsetCache } from './offset-cache'

export interface AlignInput {
  workId: string
  episode: number
  position: number
  from: AlignEndpoint
  to: AlignEndpoint
  history: DurationHistory
  capability: 'frames' | 'no-frames'
  samples?: ScoredSample[]
  elapsedMs: number
}

export interface AlignDeps {
  offsets: OffsetCache
  config: ResolvedAlignmentConfig
}

function durationInput(from: AlignEndpoint, to: AlignEndpoint): DurationInput {
  return {
    fromSeconds: from.duration ?? null,
    fromSource: from.durationSource ?? 'missing',
    toSeconds: to.duration ?? null,
    toSource: to.durationSource ?? 'missing',
  }
}

function judge(input: AlignInput, config: ResolvedAlignmentConfig) {
  const verdict = durationVerdict(durationInput(input.from, input.to), input.history, config)
  return { verdict, durationJudge: {
    basisVersion: verdict.basisVersion,
    ratioDeviation: verdict.ratioDeviation,
    absDeviation: verdict.absDeviation,
    verdict: verdict.verdict,
  } }
}

export function align(input: AlignInput, deps: AlignDeps): AlignmentResult {
  const { verdict, durationJudge } = judge(input, deps.config)
  const base = {
    durationJudge,
    samplesUsed: 0,
    elapsedMs: input.elapsedMs,
  }
  const reject = (reason: AlignmentReason): AlignmentResult =>
    ({ layer: 'rejected', verified: false, reason, ...base })

  if (verdict.verdict === 'suspect') {
    return reject(verdict.reason === 'history-inconsistent' ? 'history-inconsistent' : 'duration-suspect')
  }

  const cache = deps.offsets.lookup({
    workId: input.workId,
    episode: input.episode,
    fromSource: input.from.sourceKey,
    toSource: input.to.sourceKey,
    fingerprint: input.to.fingerprint ?? '',
    deviation: verdict.ratioDeviation,
  })
  if (cache) {
    return {
      layer: 'offset-cache',
      offsetSeconds: cache.offsetSeconds,
      verified: cache.confirmedBy === 'frame-check',
      ...base,
    }
  }

  if (input.capability === 'no-frames') {
    return { layer: 'degraded', verified: false, reason: 'frames-unavailable', ...base }
  }

  const anchors = pickOffsets(durationInput(input.from, input.to), deps.config)

  if (input.samples === undefined) {
    return {
      layer: 'frame-check',
      verified: false,
      reason: 'cache-miss',
      candidateOffsets: anchors,
      ...base,
    }
  }

  const search = windowSearch(anchors, input.samples, input.elapsedMs, deps.config)
  if (search.reason === 'over-budget') {
    return { ...base, layer: 'degraded', verified: false, reason: 'over-budget', samplesUsed: search.used }
  }
  if (search.offset === undefined) {
    return { ...base, layer: 'rejected', verified: false, reason: 'no-match', samplesUsed: search.used }
  }
  if (input.from.duration !== undefined && input.from.durationSource !== 'missing' &&
      input.to.duration !== undefined && input.to.durationSource !== 'missing') {
    deps.offsets.record({
      workId: input.workId,
      episode: input.episode,
      fromSource: input.from.sourceKey,
      toSource: input.to.sourceKey,
      fingerprint: input.to.fingerprint ?? '',
      deviation: verdict.ratioDeviation,
      offsetSeconds: search.offset,
      confirmedBy: 'frame-check',
      fromDuration: input.from.duration,
      toDuration: input.to.duration,
    })
  }
  return {
    ...base,
    layer: 'frame-check',
    offsetSeconds: search.offset,
    verified: true,
    samplesUsed: search.used,
  }
}
