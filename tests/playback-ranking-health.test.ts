import { describe, expect, it } from 'vitest'
import { combineWorkDelta, compareHealthRank, sessionScore } from '../src/main/health/rank'

describe('health ranking', () => {
  it('puts a cooled source after every available one', () => {
    expect(compareHealthRank({ cooled: false, rank: 0.1 }, { cooled: true, rank: 0.9 })).toBeLessThan(0)
    expect(compareHealthRank({ cooled: true, rank: 0.9 }, { cooled: false, rank: 0.1 })).toBeGreaterThan(0)
  })

  it('prefers the higher ranked source', () => {
    expect(compareHealthRank({ cooled: false, rank: 0.8 }, { cooled: false, rank: 0.6 })).toBeLessThan(0)
    expect(compareHealthRank({ cooled: false, rank: 0.6 }, { cooled: false, rank: 0.8 })).toBeGreaterThan(0)
  })

  it('bounds the work correction in both directions', () => {
    expect(combineWorkDelta(0.8, 0.5, 0.2)).toBeCloseTo(0.96)
    expect(combineWorkDelta(0.8, -0.5, 0.2)).toBeCloseTo(0.64)
    expect(combineWorkDelta(1, 1, 0.2)).toBeCloseTo(1)
  })

  it('lowers the session score as the stall rate rises', () => {
    expect(sessionScore(1, 60, 0)).toBe(1)
    expect(sessionScore(1, 60, 60)).toBeLessThan(sessionScore(1, 60, 12))
  })
})