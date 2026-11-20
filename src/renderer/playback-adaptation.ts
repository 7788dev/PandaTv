import { SPEEDS } from '../../design/contract/constants'
import type { Speed } from '../../design/contract/types'

export const FRAME_SAMPLE_MS = 10_000
const MIN_WINDOW_FRAMES = 120
const DROP_RATIO_TO_REDUCE = 0.1
const DROP_RATIO_TO_RESTORE = 0.02
const CLEAN_WINDOWS_TO_RESTORE = 3

export type FrameSample = { at: number; totalFrames: number; droppedFrames: number }
export type FrameRateState = { baseline: FrameSample | null; cleanWindows: number }

export function createFrameRateState(): FrameRateState {
  return { baseline: null, cleanWindows: 0 }
}

const step = (value: Speed, direction: -1 | 1, ceiling: Speed): Speed => {
  const currentIndex = SPEEDS.indexOf(value)
  const limit = SPEEDS.indexOf(ceiling)
  return SPEEDS[Math.max(0, Math.min(limit, currentIndex + direction))]
}

/** Adapt only on a full, adequately sampled playback window; frame counters reset per media load. */
export function sampleFrameRate(state: FrameRateState, sample: FrameSample, current: Speed, ceiling: Speed): { state: FrameRateState; rate: Speed } {
  const baseline = state.baseline
  if (!baseline) return { state: { baseline: sample, cleanWindows: 0 }, rate: current }

  const totalDelta = sample.totalFrames - baseline.totalFrames
  const droppedDelta = sample.droppedFrames - baseline.droppedFrames
  if (sample.at < baseline.at || totalDelta < 0 || droppedDelta < 0) {
    return { state: { baseline: sample, cleanWindows: 0 }, rate: current }
  }
  if (sample.at - baseline.at < FRAME_SAMPLE_MS) return { state, rate: current }
  if (totalDelta < MIN_WINDOW_FRAMES || totalDelta === 0) {
    return { state: { baseline: sample, cleanWindows: 0 }, rate: current }
  }

  const dropRatio = droppedDelta / totalDelta
  if (droppedDelta >= 8 && dropRatio >= DROP_RATIO_TO_REDUCE && current > 1) {
    return { state: { baseline: sample, cleanWindows: 0 }, rate: step(current, -1, ceiling) }
  }

  const cleanWindows = dropRatio <= DROP_RATIO_TO_RESTORE ? state.cleanWindows + 1 : 0
  if (cleanWindows >= CLEAN_WINDOWS_TO_RESTORE && current < ceiling) {
    return { state: { baseline: sample, cleanWindows: 0 }, rate: step(current, 1, ceiling) }
  }
  return { state: { baseline: sample, cleanWindows }, rate: current }
}
