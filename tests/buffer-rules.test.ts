import { describe, expect, it } from 'vitest'
import type { ResolvedBufferConfig } from '../src/shared/rules/config'
import { bufferThreshold, shouldTakeOver } from '../src/shared/rules/buffer'
import { playbackBuffer } from '../src/renderer/player-model'
import type { BufferSample } from '../src/shared/rules/types'

const cfg: ResolvedBufferConfig = {
  startupTargetSec: 4,
  startupWindowSec: 3,
  playingLowSec: 6,
  playingRiseWindowSec: 5,
  seekLowSec: 3,
  stallPositionSec: 20,
}

const sample = (at: number, ahead: number, position: number): BufferSample => ({ at, ahead, position })

describe('buffer rules', () => {
  it('finishes a continuously buffered ending but still detects a frozen playhead', () => {
    const ranges = { length: 2, start: (i: number) => [0, 80][i]!, end: (i: number) => [12, 90][i]! }
    expect(playbackBuffer(ranges, 13, 90)).toEqual({ ahead: 0, bufferedToEnd: false })
    const ending = (at: number, position: number) => ({ at, position, ...playbackBuffer(ranges, position, 90) })
    expect(shouldTakeOver('playing', [ending(0, 84), ending(1000, 85)], cfg).takeOver).toBe(false)
    expect(shouldTakeOver('seek', [ending(0, 89)], cfg).takeOver).toBe(false)
    expect(shouldTakeOver('playing', [ending(0, 85), ending(21000, 85)], cfg).reason).toBe('stalled')
  })

  it('reads a different threshold for startup, playing and seek', () => {
    expect(bufferThreshold('startup', cfg)).toBe(4)
    expect(bufferThreshold('playing', cfg)).toBe(6)
    expect(bufferThreshold('seek', cfg)).toBe(3)
  })

  it('never takes over during startup because of a low buffer alone', () => {
    const verdict = shouldTakeOver('startup', [sample(0, 0, 0), sample(1_000, 0, 0)], cfg)
    expect(verdict.takeOver).toBe(false)
  })

  it('takes over when startup buffer misses the target for the full startup window', () => {
    const verdict = shouldTakeOver('startup', [sample(0, 1, 0), sample(3_000, 2, 0)], cfg)
    expect(verdict).toMatchObject({ takeOver: true, reason: 'low-buffer', threshold: 4 })
  })

  it('keeps the source when startup buffer reaches the target during the window', () => {
    const verdict = shouldTakeOver('startup', [sample(0, 1, 0), sample(3_000, 4, 0)], cfg)
    expect(verdict.takeOver).toBe(false)
  })

  it('waits when the buffer is low but recovering', () => {
    const verdict = shouldTakeOver(
      'playing',
      [sample(0, 2, 100), sample(2_000, 3, 102), sample(4_000, 5, 104)],
      cfg,
    )
    expect(verdict.takeOver).toBe(false)
    expect(verdict.riseSlope).toBeGreaterThan(0)
  })

  it('takes over when the buffer is below the playing threshold and falling', () => {
    const verdict = shouldTakeOver(
      'playing',
      [sample(0, 10, 100), sample(2_000, 8, 102), sample(4_000, 5, 104)],
      cfg,
    )
    expect(verdict.takeOver).toBe(true)
    expect(verdict.reason).toBe('low-buffer')
    expect(verdict.threshold).toBe(6)
  })

  it('evaluates seek immediately against the seek threshold', () => {
    expect(shouldTakeOver('seek', [sample(0, 2, 100)], cfg).takeOver).toBe(true)
    expect(shouldTakeOver('seek', [sample(0, 4, 100)], cfg).takeOver).toBe(false)
  })

  it('takes over when the position has not advanced for the stall window', () => {
    const verdict = shouldTakeOver(
      'playing',
      [sample(0, 20, 100), sample(21_000, 20, 100)],
      cfg,
    )
    expect(verdict.takeOver).toBe(true)
    expect(verdict.reason).toBe('stalled')
  })

  it('flips the decision when the configured threshold changes', () => {
    const samples = [sample(0, 9, 100), sample(2_000, 8, 102), sample(4_000, 7, 104)]
    expect(shouldTakeOver('playing', samples, cfg).takeOver).toBe(false)
    expect(shouldTakeOver('playing', samples, { ...cfg, playingLowSec: 8 }).takeOver).toBe(true)
  })
})
