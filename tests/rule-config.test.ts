import { describe, expect, it } from 'vitest'
import { checkRuleLiterals } from '../scripts/check-rule-literals'
import {
  DEFAULT_ALIGNMENT_CONFIG,
  DEFAULT_BUDGET_CONFIG,
  DEFAULT_BUFFER_CONFIG,
  DEFAULT_HEALTH_CONFIG,
  resolveAlignmentConfig,
  resolveBudgetConfig,
  resolveBufferConfig,
  resolveHealthConfig,
} from '../src/shared/rules/config'

describe('rule config discipline', () => {
  it('has no unexplained numeric literals in rule modules', () => {
    expect(checkRuleLiterals()).toEqual([])
  })

  it('requires calibration before health and alignment defaults can decide', () => {
    expect(() => resolveHealthConfig(DEFAULT_HEALTH_CONFIG)).toThrow(/uncalibrated/)
    expect(() => resolveAlignmentConfig(DEFAULT_ALIGNMENT_CONFIG)).toThrow(/uncalibrated/)
  })

  it('resolves the buffer and budget defaults taken from the spec', () => {
    expect(resolveBufferConfig(DEFAULT_BUFFER_CONFIG).playingLowSec).toBe(6)
    expect(resolveBudgetConfig(DEFAULT_BUDGET_CONFIG).maxSwitchesPerEpisode).toBe(3)
  })

  it('rejects configs that loosen the spec caps', () => {
    expect(() => resolveAlignmentConfig({ ...DEFAULT_ALIGNMENT_CONFIG, sampleLimit: 6 })).toThrow()
    expect(() => resolveAlignmentConfig({ ...DEFAULT_ALIGNMENT_CONFIG, frameBudgetMs: 1_201 })).toThrow()
    expect(() => resolveBudgetConfig({ ...DEFAULT_BUDGET_CONFIG, maxSwitchesPerEpisode: 4 })).toThrow()
    expect(() => resolveBudgetConfig({ ...DEFAULT_BUDGET_CONFIG, minIntervalSec: 29 })).toThrow()
  })
})