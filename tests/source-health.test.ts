import { describe, expect, it } from 'vitest'
import type { ResolvedHealthConfig } from '../src/shared/rules/config'
import { scoreOf, verdictOf, withFailure } from '../src/shared/rules/health'
import type { HealthEntry } from '../src/shared/rules/types'

const DAY = 86_400_000

const cfg: ResolvedHealthConfig = {
  basisVersion: 'test-2026-11',
  decayVersion: '1',
  halfLifeDays: 30,
  baseline: 0.5,
  slowStartupSec: 6,
  playFloorSec: 60,
  workDeltaMax: 0.2,
  weights: { availability: 0.4, stability: 0.3, speed: 0.2, quality: 0.1 },
}

function entry(patch: Partial<HealthEntry> = {}): HealthEntry {
  return {
    sourceKey: 'a',
    success: 0,
    failure: { catalogue: 0, probe: 0, firstSegment: 0, stall: 0, alignment: 0 },
    startupMedian: null,
    startupWorst: null,
    playSeconds: 0,
    stallSeconds: 0,
    shownQuality: '1080P',
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null,
    score: 0,
    scoredAt: 0,
    decayVersion: '1',
    cooldownUntil: null,
    lastAlignmentDegrade: null,
    ...patch,
  }
}

describe('source health rules', () => {
  it('lets a recently successful source recover from old failures', () => {
    const at = 100 * DAY
    const oldFailure = entry({
      failure: { catalogue: 0, probe: 5, firstSegment: 0, stall: 0, alignment: 0 },
      scoredAt: at - 60 * DAY,
    })
    const recovered = entry({ success: 20, scoredAt: at - DAY })
    expect(scoreOf(recovered, at, cfg)).toBeGreaterThan(scoreOf(oldFailure, at, cfg))
  })

  it('prefers a recently measured healthy source over a stale success record', () => {
    const at = 100 * DAY
    const stale = entry({ success: 50, scoredAt: at - 90 * DAY })
    const fresh = entry({ success: 10, scoredAt: at - DAY })
    expect(scoreOf(fresh, at, cfg)).toBeGreaterThan(scoreOf(stale, at, cfg))
  })

  it('ranks a source by stall rate when quality and startup are equal', () => {
    const at = 100 * DAY
    const stable = entry({ success: 5, playSeconds: 600, stallSeconds: 0, scoredAt: at })
    const stalling = entry({ success: 5, playSeconds: 600, stallSeconds: 108, scoredAt: at })
    expect(scoreOf(stable, at, cfg)).toBeGreaterThan(scoreOf(stalling, at, cfg))
  })

  it('expires cooldown automatically without removing the source', () => {
    const at = 100 * DAY
    expect(verdictOf(entry({ cooldownUntil: at - 1 }), at, cfg).cooled).toBe(false)
    const active = verdictOf(entry({ cooldownUntil: at + 1, success: 10, scoredAt: at }), at, cfg)
    expect(active.cooled).toBe(true)
    expect(active.rank).toBe(-1)
  })

  it('does not permanently disable a source after one timeout', () => {
    const at = 100 * DAY
    const once = entry({
      success: 20,
      failure: { catalogue: 0, probe: 1, firstSegment: 0, stall: 0, alignment: 0 },
      scoredAt: at,
    })
    expect(scoreOf(once, at, cfg)).toBeGreaterThan(0.6)
  })

  it('returns the same score for the same entry, timestamp and config', () => {
    const at = 100 * DAY
    const sample = entry({ success: 12, scoredAt: at - 3 * DAY })
    expect(scoreOf(sample, at, cfg)).toBe(scoreOf(sample, at, cfg))
  })

  it('records a failure without mutating the input entry', () => {
    const at = 100 * DAY
    const base = entry({ success: 3, scoredAt: at - DAY })
    const next = withFailure(base, 'first-segment', at, cfg, 300)
    expect(base.failure.firstSegment).toBe(0)
    expect(base.cooldownUntil).toBeNull()
    expect(next.failure.firstSegment).toBe(1)
    expect(next.lastFailureKind).toBe('first-segment')
    expect(next.cooldownUntil).toBe(at + 300_000)
  })
})