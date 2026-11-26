import type { ResolvedBufferConfig } from './config'
import type { BufferSample, BufferScene } from './types'

export interface TakeoverVerdict {
  readonly takeOver: boolean
  readonly reason?: 'stalled' | 'low-buffer'
  readonly threshold: number
  readonly ahead: number
  readonly riseSlope?: number
}

export function bufferThreshold(scene: BufferScene, cfg: ResolvedBufferConfig): number {
  if (scene === 'startup') return cfg.startupTargetSec
  if (scene === 'seek') return cfg.seekLowSec
  return cfg.playingLowSec
}

export function shouldTakeOver(
  scene: BufferScene,
  samples: readonly BufferSample[],
  cfg: ResolvedBufferConfig,
): TakeoverVerdict {
  const threshold = bufferThreshold(scene, cfg)
  if (samples.length === 0) return { takeOver: false, threshold, ahead: 0 }

  const last = samples[samples.length - 1]!
  const ahead = last.ahead
  const low = !last.bufferedToEnd && ahead < threshold
  if (scene === 'startup') {
    const elapsed = (last.at - samples[0]!.at) / 1000
    return elapsed >= cfg.startupWindowSec && low
      ? { takeOver: true, reason: 'low-buffer', threshold, ahead }
      : { takeOver: false, threshold, ahead }
  }
  if (scene === 'seek') {
    return low
      ? { takeOver: true, reason: 'low-buffer', threshold, ahead }
      : { takeOver: false, threshold, ahead }
  }

  const riseStart = last.at - cfg.playingRiseWindowSec * 1000
  const inWindow = samples.filter(sample => sample.at >= riseStart)
  const first = inWindow[0] ?? last
  const dtSec = (last.at - first.at) / 1000
  const riseSlope = inWindow.length >= 2 && dtSec > 0 ? (last.ahead - first.ahead) / dtSec : undefined

  const stallBefore = samples.filter(sample => sample.at <= last.at - cfg.stallPositionSec * 1000)
  const stallBase = stallBefore[stallBefore.length - 1]
  const stalled = stallBase !== undefined && last.position <= stallBase.position

  const falling = riseSlope !== undefined && riseSlope <= 0
  if (stalled) return { takeOver: true, reason: 'stalled', threshold, ahead, riseSlope }
  if (low && falling) return { takeOver: true, reason: 'low-buffer', threshold, ahead, riseSlope }
  return { takeOver: false, threshold, ahead, riseSlope }
}
