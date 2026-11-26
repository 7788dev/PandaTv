import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { QUALITIES } from '../../contract/constants'
import type { Quality } from '../../contract/types'
import { FAILURE_KINDS, type AlignmentReason, type FailureCounts, type FailureKind, type HealthEntry } from '../../shared/rules/types'

export interface WorkHealthEntry {
  workId: string
  sourceKey: string
  episodeFrom: number
  episodeTo: number
  available: boolean
  lastSuccessAt: number | null
  lastFailureKind: FailureKind | null
  scoreDelta: number
}

export interface SourceHealthArchive {
  version: 1
  writtenAt: number
  atomicMarker: string
  decayVersion: string
  globals: HealthEntry[]
  works: WorkHealthEntry[]
  durations: DurationObservation[]
}

export interface DurationObservation {
  workId: string
  episode: number
  sourceKey: string
  seconds: number
}

export const DURATION_LIMIT = 2400

export function emptyArchive(decayVersion: string, at = Date.now()): SourceHealthArchive {
  return { version: 1, writtenAt: at, atomicMarker: 'panda-source-health-v1', decayVersion, globals: [], works: [], durations: [] }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nonNegative(value: unknown): number {
  return Math.max(0, numberOr(value, 0))
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function timeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function qualityOrNull(value: unknown): Quality | null {
  return typeof value === 'string' && QUALITIES.includes(value as Quality) ? value as Quality : null
}

function failureKindOrNull(value: unknown): FailureKind | null {
  return typeof value === 'string' && FAILURE_KINDS.includes(value as FailureKind) ? value as FailureKind : null
}

function failureCounts(value: unknown): FailureCounts {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    catalogue: nonNegative(row.catalogue),
    probe: nonNegative(row.probe),
    firstSegment: nonNegative(row.firstSegment),
    stall: nonNegative(row.stall),
    alignment: nonNegative(row.alignment),
  }
}

function parseEntry(value: unknown, fallbackDecay: string): HealthEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.sourceKey !== 'string' || row.sourceKey.length === 0 || row.sourceKey.length > 80) return null
  return {
    sourceKey: row.sourceKey,
    success: nonNegative(row.success),
    failure: failureCounts(row.failure),
    startupMedian: positiveOrNull(row.startupMedian),
    startupWorst: positiveOrNull(row.startupWorst),
    playSeconds: nonNegative(row.playSeconds),
    stallSeconds: nonNegative(row.stallSeconds),
    shownQuality: qualityOrNull(row.shownQuality),
    lastSuccessAt: timeOrNull(row.lastSuccessAt),
    lastFailureAt: timeOrNull(row.lastFailureAt),
    lastFailureKind: failureKindOrNull(row.lastFailureKind),
    score: Math.max(0, Math.min(1, numberOr(row.score, 0))),
    scoredAt: timeOrNull(row.scoredAt) ?? Date.now(),
    decayVersion: typeof row.decayVersion === 'string' ? row.decayVersion : fallbackDecay,
    cooldownUntil: timeOrNull(row.cooldownUntil),
    lastAlignmentDegrade: typeof row.lastAlignmentDegrade === 'string' ? row.lastAlignmentDegrade as AlignmentReason : null,
  }
}

function parseWork(value: unknown): WorkHealthEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.workId !== 'string' || row.workId.length === 0 || row.workId.length > 400) return null
  if (typeof row.sourceKey !== 'string' || row.sourceKey.length === 0 || row.sourceKey.length > 80) return null
  const from = Math.floor(numberOr(row.episodeFrom, 1))
  const to = Math.max(from, Math.floor(numberOr(row.episodeTo, from)))
  return {
    workId: row.workId,
    sourceKey: row.sourceKey,
    episodeFrom: from,
    episodeTo: to,
    available: row.available !== false,
    lastSuccessAt: timeOrNull(row.lastSuccessAt),
    lastFailureKind: failureKindOrNull(row.lastFailureKind),
    scoreDelta: Math.max(-1, Math.min(1, numberOr(row.scoreDelta, 0))),
  }
}

export function parseArchive(text: string, decayVersion: string): SourceHealthArchive {
  const root = JSON.parse(text) as Record<string, unknown>
  if (root.version !== 1) throw new Error('SOURCE_HEALTH_VERSION')
  if (!Array.isArray(root.globals) || !Array.isArray(root.works)) throw new Error('SOURCE_HEALTH_CORRUPT')
  const durations = Array.isArray(root.durations) ? root.durations.slice(-DURATION_LIMIT).filter(
    (row): row is DurationObservation => row && typeof row.workId === 'string' && typeof row.sourceKey === 'string' &&
      Number.isInteger(row.episode) && row.episode > 0 && Number.isFinite(row.seconds) && row.seconds > 0,
  ) : []
  return {
    version: 1,
    writtenAt: timeOrNull(root.writtenAt) ?? Date.now(),
    atomicMarker: typeof root.atomicMarker === 'string' ? root.atomicMarker : 'panda-source-health-v1',
    decayVersion,
    durations,
    globals: root.globals.flatMap(value => {
      const entry = parseEntry(value, decayVersion)
      return entry ? [entry] : []
    }).slice(0, 128),
    works: root.works.flatMap(value => {
      const work = parseWork(value)
      return work ? [work] : []
    }).slice(0, 2400),
  }
}

export function readArchive(path: string, decayVersion: string): SourceHealthArchive {
  if (!existsSync(path)) return emptyArchive(decayVersion)
  try {
    return parseArchive(readFileSync(path, 'utf8'), decayVersion)
  } catch (error) {
    try { copyFileSync(path, `${path}.bak`) } catch { /* The unreadable original is still left in place. */ }
    if (error instanceof Error && error.message === 'SOURCE_HEALTH_VERSION') {
      try { copyFileSync(path, `${path}.unsupported-${randomUUID()}`) } catch { /* Keep running with an empty archive. */ }
    }
    return emptyArchive(decayVersion)
  }
}

export function writeArchive(path: string, archive: SourceHealthArchive): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const rollback = `${path}.${randomUUID()}.rollback`
  try {
    writeFileSync(temporary, JSON.stringify(archive), { mode: 0o600, flag: 'wx', flush: true })
    if (existsSync(path)) copyFileSync(path, `${path}.bak`)
    try {
      renameSync(temporary, path)
    } catch (error) {
      if (!existsSync(path)) throw error
      renameSync(path, rollback)
      try { renameSync(temporary, path) }
      catch (replaceError) {
        renameSync(rollback, path)
        throw replaceError
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
    if (existsSync(rollback)) unlinkSync(rollback)
  }
}
