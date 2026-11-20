import { describe, expect, it } from 'vitest'
import type { Speed } from '../design/contract/types'
import { FRAME_SAMPLE_MS, createFrameRateState, sampleFrameRate } from '../src/renderer/playback-adaptation'

describe('decoder frame-rate adaptation', () => {
  it('never slows ordinary playback below 1x or a manually requested slow rate', () => {
    for (const [current, requested] of [[1, 2], [0.75, 0.75]] as const) {
      const state = sampleFrameRate(createFrameRateState(), { at: 0, totalFrames: 0, droppedFrames: 0 }, current, requested).state
      expect(sampleFrameRate(state, { at: FRAME_SAMPLE_MS, totalFrames: 400, droppedFrames: 80 }, current, requested).rate).toBe(current)
    }
  })

  it('waits for a full observation window and enough decoded frames', () => {
    let state = createFrameRateState()
    let result = sampleFrameRate(state, { at: 0, totalFrames: 100, droppedFrames: 0 }, 2, 2)
    state = result.state
    result = sampleFrameRate(state, { at: FRAME_SAMPLE_MS - 1, totalFrames: 140, droppedFrames: 20 }, 2, 2)
    expect(result.rate).toBe(2)
    result = sampleFrameRate(result.state, { at: FRAME_SAMPLE_MS, totalFrames: 200, droppedFrames: 22 }, 2, 2)
    expect(result.rate).toBe(2)
  })

  it('lowers one step after a sustained decoder drop window', () => {
    let state = createFrameRateState()
    state = sampleFrameRate(state, { at: 0, totalFrames: 100, droppedFrames: 0 }, 2, 2).state
    const result = sampleFrameRate(state, { at: FRAME_SAMPLE_MS, totalFrames: 500, droppedFrames: 60 }, 2, 2)
    expect(result.rate).toBe(1.5)
  })

  it('restores one step after three clean windows, never above the requested speed', () => {
    let state = createFrameRateState()
    let rate: Speed = 1.5
    let at = 0
    let total = 0
    let dropped = 0
    state = sampleFrameRate(state, { at, totalFrames: total, droppedFrames: dropped }, rate, 2).state
    for (let i = 0; i < 3; i++) {
      at += FRAME_SAMPLE_MS
      total += 400
      const result = sampleFrameRate(state, { at, totalFrames: total, droppedFrames: dropped }, rate, 2)
      state = result.state
      rate = result.rate
    }
    expect(rate).toBe(2)
  })

  it('treats reset counters as a new media baseline', () => {
    let state = createFrameRateState()
    state = sampleFrameRate(state, { at: 0, totalFrames: 1000, droppedFrames: 100 }, 2, 2).state
    const result = sampleFrameRate(state, { at: FRAME_SAMPLE_MS, totalFrames: 10, droppedFrames: 0 }, 2, 2)
    expect(result.rate).toBe(2)
    expect(result.state.baseline).toEqual({ at: FRAME_SAMPLE_MS, totalFrames: 10, droppedFrames: 0 })
  })
})
