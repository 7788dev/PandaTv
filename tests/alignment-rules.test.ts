import { describe, expect, it } from 'vitest'
import { frameSample } from '../src/renderer/playback-alignment'
import type { ResolvedAlignmentConfig } from '../src/shared/rules/config'
import {
  durationVerdict,
  pickOffsets,
  similarity,
  windowSearch,
} from '../src/shared/rules/alignment'
import type { DurationHistory, DurationInput, FrameSample, ScoredSample } from '../src/shared/rules/types'

const cfg: ResolvedAlignmentConfig = {
  basisVersion: 'calib-a',
  ratioTolerance: 0.001,
  absoluteToleranceSec: 5,
  historyConsistencyRatio: 0.05,
  workSpreadFactor: 4,
  windowSeconds: 3,
  sampleLimit: 5,
  frameBudgetMs: 1_200,
  similarityThreshold: 0.9,
  offsetTtlDays: 7,
  takeoverHeadroomFactor: 1.5,
}

const emptyHistory: DurationHistory = { sourceSamples: [], workRatios: [] }

function input(from: number | null, to: number | null): DurationInput {
  return {
    fromSeconds: from,
    fromSource: from === null ? 'missing' : 'hls-extinf',
    toSeconds: to,
    toSource: to === null ? 'missing' : 'hls-extinf',
  }
}

const frame = (hash: string, offsetSeconds = 0): ScoredSample => ({
  offsetSeconds,
  similarity: 0,
  valid: hash.length > 0,
})

describe('alignment rules', () => {
  it('cannot verify an offset using two different solid frames', () => {
    for (const level of [0, 128, 255]) {
      expect(frameSample(new Uint8ClampedArray(9 * 8 * 4).fill(level))).toEqual({ valid: false, hash: '' })
    }
    const textured = new Uint8ClampedArray(9 * 8 * 4)
    for (let x = 0; x < 72; x += 2) textured.fill(255, x * 4, x * 4 + 4)
    expect(frameSample(textured)).toMatchObject({ valid: true })
  })

  it('returns unknown when either side has no measured duration', () => {
    const verdict = durationVerdict(input(1200, null), emptyHistory, cfg)
    expect(verdict.verdict).toBe('unknown')
    expect(verdict.measured).toBe(false)
    expect(verdict.reason).toBe('duration-missing')
  })

  it('treats positive and negative deviations the same way', () => {
    const longer = durationVerdict(input(1200, 1205), emptyHistory, cfg)
    const shorter = durationVerdict(input(1200, 1195), emptyHistory, cfg)
    expect(longer.verdict).toBe(shorter.verdict)
    expect(longer.ratioDeviation).toBeCloseTo(shorter.ratioDeviation)
    expect(longer.absDeviation).toBeCloseTo(shorter.absDeviation)
  })

  it('changes the verdict when a different calibration config is used', () => {
    const strict = { ...cfg, ratioTolerance: 0.001, absoluteToleranceSec: 1 }
    const loose = { ...cfg, ratioTolerance: 0.01, absoluteToleranceSec: 5 }
    expect(durationVerdict(input(1200, 1210), emptyHistory, strict).verdict).toBe('suspect')
    expect(durationVerdict(input(1200, 1210), emptyHistory, loose).verdict).toBe('consistent')
  })

  it('flags a source whose own historical durations contradict each other', () => {
    const verdict = durationVerdict(input(1200, 1205), { sourceSamples: [1200, 1500], workRatios: [] }, cfg)
    expect(verdict.verdict).toBe('suspect')
    expect(verdict.reason).toBe('history-inconsistent')
  })

  it('flags an episode that is an outlier against the rest of the work', () => {
    const verdict = durationVerdict(input(1200, 1210), { sourceSamples: [], workRatios: [0.001, 0.001, 0.001] }, cfg)
    expect(verdict.verdict).toBe('suspect')
    expect(verdict.reason).toBe('work-outlier')
  })

  it('builds at most three anchor offsets from the duration delta', () => {
    expect(pickOffsets(input(1200, 1205), cfg)).toEqual([0, 5, -5])
    expect(pickOffsets(input(1200, 1200), cfg)).toEqual([0])
    expect(pickOffsets(input(1200, null), cfg)).toEqual([0])
  })

  it('compares frame hashes by hamming distance', () => {
    const all: FrameSample = { valid: true, hash: 'ffffffffffffffff' }
    const none: FrameSample = { valid: true, hash: '0000000000000000' }
    expect(similarity(all, all)).toBe(1)
    expect(similarity(all, none)).toBe(0)
    expect(similarity(all, { valid: false, hash: 'ffffffffffffffff' })).toBe(0)
    expect(similarity({ valid: true, hash: 'ff' }, { valid: true, hash: 'ff' })).toBe(1)
  })

  it('finds the best matching offset inside the sample window', () => {
    const samples: ScoredSample[] = [
      { offsetSeconds: 0, similarity: 0.2, valid: true },
      { offsetSeconds: 1, similarity: 0.95, valid: true },
      { offsetSeconds: 2, similarity: 0.4, valid: true },
    ]
    expect(windowSearch([0, 5, -5], samples, 400, cfg)).toEqual({ offset: 1, used: 3 })
  })

  it('reports over-budget when the frame budget or sample limit is exceeded', () => {
    expect(windowSearch([0], [frame('ffffffffffffffff', 0)], 1_201, cfg)).toEqual({
      used: 0,
      reason: 'over-budget',
    })
    const six = Array.from({ length: 6 }, (_, i) => ({ offsetSeconds: 0, similarity: 0.99, valid: true }))
    expect(windowSearch([0], six, 100, cfg)).toEqual({ used: 6, reason: 'over-budget' })
  })

  it('ignores invalid samples and reports no match below the similarity threshold', () => {
    const samples: ScoredSample[] = [
      { offsetSeconds: 0, similarity: 0.99, valid: false },
      { offsetSeconds: 1, similarity: 0.5, valid: true },
    ]
    expect(windowSearch([0], samples, 100, cfg)).toEqual({ used: 1, reason: 'no-match' })
  })
})
