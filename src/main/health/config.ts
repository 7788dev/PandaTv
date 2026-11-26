import { readFileSync } from 'node:fs'
import type {
  AlignmentConfig,
  BudgetConfig,
  BufferConfig,
  HealthConfig,
  ResolvedAlignmentConfig,
  ResolvedBudgetConfig,
  ResolvedBufferConfig,
  ResolvedHealthConfig,
} from '../../shared/rules/config'
import {
  resolveAlignmentConfig,
  resolveBudgetConfig,
  resolveBufferConfig,
  resolveHealthConfig,
} from '../../shared/rules/config'

export interface RuleCalibration {
  health: ResolvedHealthConfig
  buffer: ResolvedBufferConfig
  budget: ResolvedBudgetConfig
  alignment: ResolvedAlignmentConfig
}

interface CalibrationFile {
  health: HealthConfig
  buffer: BufferConfig
  budget: BudgetConfig
  alignment: AlignmentConfig
}

export function parseRuleCalibration(raw: unknown): RuleCalibration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CALIBRATION_INVALID')
  const file = raw as CalibrationFile
  return {
    health: resolveHealthConfig(file.health),
    buffer: resolveBufferConfig(file.buffer),
    budget: resolveBudgetConfig(file.budget),
    alignment: resolveAlignmentConfig(file.alignment),
  }
}

export function loadRuleCalibration(path: string): RuleCalibration | null {
  try {
    return parseRuleCalibration(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    console.info('[health]', 'calibration unavailable', error instanceof Error ? error.message : String(error))
    return null
  }
}