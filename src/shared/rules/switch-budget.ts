import type { ResolvedBudgetConfig } from './config'
import type { SwitchEvent } from './types'

export interface SwitchDecision {
  readonly allowed: boolean
  readonly reason?: 'limit' | 'interval'
  readonly attempts: number
}

export interface UnavailableMark {
  readonly sourceKey: string
  readonly until: number
}

export function evaluateSwitch(
  events: readonly SwitchEvent[],
  at: number,
  cfg: ResolvedBudgetConfig,
): SwitchDecision {
  const auto = events.filter(event => event.mode === 'auto')
  const attempts = auto.length
  if (attempts >= cfg.maxSwitchesPerEpisode) return { allowed: false, reason: 'limit', attempts }
  if (auto.length > 0) {
    const last = Math.max(...auto.map(event => event.at))
    if (at - last < cfg.minIntervalSec * 1000) return { allowed: false, reason: 'interval', attempts }
  }
  return { allowed: true, attempts }
}

export function markUnavailableOnce(
  sourceKey: string,
  at: number,
  cfg: ResolvedBudgetConfig,
): UnavailableMark {
  return { sourceKey, until: at + cfg.failedSourceCooldownSec * 1000 }
}

export function isUnavailable(mark: UnavailableMark, at: number): boolean {
  return mark.until > at
}