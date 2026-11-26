import type { Quality } from '../../contract/types'

export const FAILURE_KINDS = ['catalogue', 'probe', 'first-segment', 'stall', 'alignment'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

export interface FailureCounts {
  readonly catalogue: number
  readonly probe: number
  readonly firstSegment: number
  readonly stall: number
  readonly alignment: number
}

export interface HealthEntry {
  readonly sourceKey: string
  readonly success: number
  readonly failure: FailureCounts
  readonly startupMedian: number | null
  readonly startupWorst: number | null
  readonly playSeconds: number
  readonly stallSeconds: number
  readonly shownQuality: Quality | null
  readonly lastSuccessAt: number | null
  readonly lastFailureAt: number | null
  readonly lastFailureKind: FailureKind | null
  readonly score: number
  readonly scoredAt: number
  readonly decayVersion: string
  readonly cooldownUntil: number | null
  readonly lastAlignmentDegrade: AlignmentReason | null
}

export type BufferScene = 'startup' | 'playing' | 'seek'

export interface BufferSample {
  readonly at: number
  readonly ahead: number
  readonly position: number
  readonly bufferedToEnd?: boolean
}

export type SwitchMode = 'auto' | 'manual'

export interface SwitchEvent {
  readonly at: number
  readonly mode: SwitchMode
}

export type DurationSource = 'hls-extinf' | 'mp4-moov' | 'missing'

export interface DurationInput {
  readonly fromSeconds: number | null
  readonly fromSource: DurationSource
  readonly toSeconds: number | null
  readonly toSource: DurationSource
}

export interface DurationHistory {
  /** 同一目标源在同一集上的历史时长观测（秒） */
  readonly sourceSamples: readonly number[]
  /** 本作品其他集的历史偏差比例（|to-from|/max(from,1)） */
  readonly workRatios: readonly number[]
}

export type DurationVerdictKind = 'consistent' | 'suspect' | 'unknown'

export type DurationReason = 'duration-missing' | 'history-inconsistent' | 'work-outlier'

export interface DurationVerdict {
  readonly verdict: DurationVerdictKind
  readonly measured: boolean
  readonly ratioDeviation: number
  readonly absDeviation: number
  readonly basisVersion: string
  readonly reason?: DurationReason
}

export interface FrameSample {
  readonly valid: boolean
  /** 64 位 dHash 的十六进制串，invalid 时为空串 */
  readonly hash: string
}

export interface ScoredSample {
  readonly offsetSeconds: number
  readonly similarity: number
  readonly valid: boolean
}

export type AlignmentLayer = 'duration' | 'offset-cache' | 'frame-check' | 'degraded' | 'rejected'

export type AlignmentReason =
  | 'duration-suspect'
  | 'duration-missing'
  | 'cache-miss'
  | 'no-match'
  | 'over-budget'
  | 'frames-unavailable'
  | 'history-inconsistent'

export interface AlignEndpoint {
  readonly sourceKey: string
  readonly line?: string
  readonly duration?: number
  readonly durationSource?: DurationSource
  readonly fingerprint?: string
}

export interface AlignInput {
  readonly workId: string
  readonly episode: number
  readonly position: number
  readonly from: AlignEndpoint
  readonly to: AlignEndpoint
  readonly capability: 'frames' | 'no-frames'
  readonly samples?: ScoredSample[]
  readonly elapsedMs: number
}

export interface AlignmentResult {
  readonly layer: AlignmentLayer
  readonly offsetSeconds?: number
  readonly candidateOffsets?: number[]
  readonly verified: boolean
  readonly reason?: AlignmentReason
  readonly durationJudge: {
    readonly basisVersion: string
    readonly ratioDeviation: number
    readonly absDeviation: number
    readonly verdict: DurationVerdictKind
  }
  readonly samplesUsed: number
  readonly elapsedMs: number
}
export interface SourceHealthGlobalView {
  readonly sourceKey: string
  readonly score: number
  readonly cooled: boolean
  readonly success: number
  readonly failure: FailureCounts
  readonly playSeconds: number
  readonly stallSeconds: number
  readonly startupMedian: number | null
  readonly shownQuality: Quality | null
  readonly lastFailureKind: FailureKind | null
}

export interface SourceHealthWorkView {
  readonly workId: string
  readonly sourceKey: string
  readonly available: boolean
  readonly scoreDelta: number
  readonly lastSuccessAt: number | null
  readonly lastFailureKind: FailureKind | null
}

export interface SourceHealthSnapshot {
  readonly generatedAt: number
  readonly config: {
    readonly basisVersion: string
    readonly decayVersion: string
    readonly maxSwitchesPerEpisode: number
    readonly minIntervalSec: number
    readonly failedSourceCooldownSec: number
  }
  readonly globals: SourceHealthGlobalView[]
  readonly works: SourceHealthWorkView[]
}
