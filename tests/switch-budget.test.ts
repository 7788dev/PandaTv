import { describe, expect, it } from 'vitest'
import type { ResolvedBudgetConfig } from '../src/shared/rules/config'
import { evaluateSwitch, isUnavailable, markUnavailableOnce } from '../src/shared/rules/switch-budget'
import type { SwitchEvent } from '../src/shared/rules/types'

const cfg: ResolvedBudgetConfig = {
  maxSwitchesPerEpisode: 3,
  minIntervalSec: 30,
  failedSourceCooldownSec: 300,
}

const at = 1_000_000

function auto(times: number[]): SwitchEvent[] {
  return times.map(time => ({ at: time, mode: 'auto' }))
}

describe('switch budget rules', () => {
  it('allows the first automatic switch', () => {
    expect(evaluateSwitch([], at, cfg)).toEqual({ allowed: true, attempts: 0 })
  })

  it('denies the fourth automatic switch in the same episode', () => {
    const events = auto([at - 120_000, at - 90_000, at - 60_000])
    expect(evaluateSwitch(events, at, cfg)).toEqual({ allowed: false, reason: 'limit', attempts: 3 })
  })

  it('denies a switch inside the minimum interval', () => {
    expect(evaluateSwitch(auto([at - 10_000]), at, cfg)).toEqual({
      allowed: false,
      reason: 'interval',
      attempts: 1,
    })
  })

  it('does not count manual picks against the automatic budget', () => {
    const events: SwitchEvent[] = [
      { at: at - 1_000, mode: 'manual' },
      { at: at - 2_000, mode: 'manual' },
      { at: at - 3_000, mode: 'manual' },
    ]
    expect(evaluateSwitch(events, at, cfg)).toEqual({ allowed: true, attempts: 0 })
  })

  it('expires an unavailable mark after the cooldown', () => {
    const mark = markUnavailableOnce('b', at, cfg)
    expect(isUnavailable(mark, at + 299_000)).toBe(true)
    expect(isUnavailable(mark, at + 300_000)).toBe(false)
  })

  it('flips the decision when the switch limit changes', () => {
    const events = auto([at - 90_000, at - 60_000])
    expect(evaluateSwitch(events, at, cfg).allowed).toBe(true)
    expect(evaluateSwitch(events, at, { ...cfg, maxSwitchesPerEpisode: 2 })).toEqual({
      allowed: false,
      reason: 'limit',
      attempts: 2,
    })
  })
})