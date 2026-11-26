import type { Quality } from '../../contract/types'
import type { ResolvedBudgetConfig, ResolvedHealthConfig } from '../../shared/rules/config'
import { scoreOf, verdictOf, withFailure } from '../../shared/rules/health'
import type {
  FailureCounts,
  DurationHistory,
  FailureKind,
  HealthEntry,
  SourceHealthSnapshot,
} from '../../shared/rules/types'
import { DURATION_LIMIT, readArchive, writeArchive, type SourceHealthArchive, type WorkHealthEntry } from './archive'
import { combineWorkDelta } from './rank'

const FLUSH_MS = 5 * 60 * 1000
const GLOBAL_LIMIT = 128
const WORK_LIMIT = 2400
const WORK_STEP = 0.05

interface LiveStats {
  playSeconds: number
  stallSeconds: number
}

export interface LiveInput {
  playSeconds?: number
  stallSeconds?: number
}

function emptyEntry(sourceKey: string, at: number, decayVersion: string): HealthEntry {
  return {
    sourceKey,
    success: 0,
    failure: { catalogue: 0, probe: 0, firstSegment: 0, stall: 0, alignment: 0 },
    startupMedian: null,
    startupWorst: null,
    playSeconds: 0,
    stallSeconds: 0,
    shownQuality: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null,
    score: 0,
    scoredAt: at,
    decayVersion,
    cooldownUntil: null,
    lastAlignmentDegrade: null,
  }
}

export class SourceHealthStore {
  private archive: SourceHealthArchive
  private readonly live = new Map<string, LiveStats>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null

  constructor(
    private readonly path: string,
    private readonly cfg: ResolvedHealthConfig,
    private readonly budget: ResolvedBudgetConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.archive = readArchive(path, cfg.decayVersion)
  }

  private globalEntry(sourceKey: string): HealthEntry | undefined {
    return this.archive.globals.find(entry => entry.sourceKey === sourceKey)
  }

  private ensureGlobal(sourceKey: string): HealthEntry {
    const existing = this.globalEntry(sourceKey)
    if (existing) return existing
    const at = this.now()
    const entry = emptyEntry(sourceKey, at, this.cfg.decayVersion)
    this.archive.globals.push(entry)
    if (this.archive.globals.length > GLOBAL_LIMIT) this.archive.globals.shift()
    return entry
  }

  private replaceGlobal(entry: HealthEntry): void {
    const index = this.archive.globals.findIndex(current => current.sourceKey === entry.sourceKey)
    if (index < 0) this.archive.globals.push(entry)
    else this.archive.globals[index] = entry
  }

  private withLive(entry: HealthEntry): HealthEntry {
    const live = this.live.get(entry.sourceKey)
    if (!live || (live.playSeconds <= 0 && live.stallSeconds <= 0)) return entry
    return {
      ...entry,
      playSeconds: entry.playSeconds + live.playSeconds,
      stallSeconds: entry.stallSeconds + live.stallSeconds,
    }
  }

  private touchWork(
    workId: string,
    sourceKey: string,
    episode: number,
    available: boolean,
    at: number,
    kind: FailureKind | null,
    delta: number,
  ): void {
    const index = this.archive.works.findIndex(work => work.workId === workId && work.sourceKey === sourceKey)
    const existing = index >= 0 ? this.archive.works[index]! : undefined
    const next: WorkHealthEntry = existing
      ? {
          ...existing,
          episodeFrom: Math.min(existing.episodeFrom, episode),
          episodeTo: Math.max(existing.episodeTo, episode),
          available,
          lastSuccessAt: available ? at : existing.lastSuccessAt,
          lastFailureKind: available ? existing.lastFailureKind : kind,
          scoreDelta: Math.max(-1, Math.min(1, existing.scoreDelta + delta)),
        }
      : {
          workId,
          sourceKey,
          episodeFrom: episode,
          episodeTo: episode,
          available,
          lastSuccessAt: available ? at : null,
          lastFailureKind: available ? null : kind,
          scoreDelta: Math.max(-1, Math.min(1, delta)),
        }
    if (index >= 0) this.archive.works[index] = next
    else {
      this.archive.works.push(next)
      if (this.archive.works.length > WORK_LIMIT) {
        const oldest = this.archive.works.reduce((a, b) =>
          (a.lastSuccessAt ?? 0) <= (b.lastSuccessAt ?? 0) ? a : b,
        )
        this.archive.works = this.archive.works.filter(work => work !== oldest)
      }
    }
  }

  rankFor(sourceKey: string, workId: string, at = this.now()): { cooled: boolean; rank: number } {
    const entry = this.globalEntry(sourceKey)
    if (!entry) return { cooled: false, rank: 0.5 }
    const verdict = verdictOf(this.withLive(entry), at, this.cfg)
    if (verdict.cooled) return { cooled: true, rank: -1 }
    const work = this.archive.works.find(item => item.workId === workId && item.sourceKey === sourceKey)
    return {
      cooled: false,
      rank: combineWorkDelta(verdict.rank, work?.scoreDelta ?? 0, this.cfg.workDeltaMax),
    }
  }

  recordSuccess(
    sourceKey: string,
    workId: string,
    episode: number,
    at = this.now(),
    startupSec?: number,
    quality?: Quality,
  ): void {
    const entry = this.ensureGlobal(sourceKey)
    const draft: HealthEntry = {
      ...entry,
      success: entry.success + 1,
      lastSuccessAt: at,
      cooldownUntil: null,
      startupMedian: startupSec === undefined ? entry.startupMedian
        : entry.startupMedian === null ? startupSec : entry.startupMedian * 0.7 + startupSec * 0.3,
      startupWorst: startupSec === undefined ? entry.startupWorst : Math.max(entry.startupWorst ?? 0, startupSec),
      shownQuality: quality ?? entry.shownQuality,
      score: 0,
      scoredAt: at,
    }
    this.replaceGlobal({ ...draft, score: scoreOf(draft, at, this.cfg) })
    this.touchWork(workId, sourceKey, episode, true, at, null, WORK_STEP)
    this.scheduleFlush()
  }

  observeDuration(workId: string, episode: number, sourceKey: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const rows = this.archive.durations
    const previous = rows.findLast(row => row.workId === workId && row.episode === episode && row.sourceKey === sourceKey)
    if (previous?.seconds === seconds) return
    rows.push({ workId, episode, sourceKey, seconds })
    if (rows.length > DURATION_LIMIT) rows.shift()
    this.scheduleFlush()
  }

  durationHistory(workId: string, episode: number, from: string, to: string): DurationHistory {
    const sourceSamples: number[] = []
    const peers = new Map<number, { from?: number; to?: number }>()
    for (const row of this.archive.durations) {
      if (row.workId !== workId || (row.sourceKey !== from && row.sourceKey !== to)) continue
      if (row.episode === episode) {
        if (row.sourceKey === to) sourceSamples.push(row.seconds)
      } else {
        const pair = peers.get(row.episode) ?? {}
        pair[row.sourceKey === from ? 'from' : 'to'] = row.seconds
        peers.set(row.episode, pair)
      }
    }
    const workRatios: number[] = []
    for (const pair of peers.values()) {
      if (pair.from !== undefined && pair.to !== undefined) workRatios.push(Math.abs(pair.to - pair.from) / Math.max(pair.from, 1))
    }
    return { sourceSamples, workRatios }
  }

  recordFailure(
    sourceKey: string,
    kind: FailureKind,
    workId: string,
    episode: number,
    at = this.now(),
  ): void {
    const entry = this.ensureGlobal(sourceKey)
    const next = withFailure(entry, kind, at, this.cfg, this.budget.failedSourceCooldownSec)
    this.replaceGlobal(next)
    this.touchWork(workId, sourceKey, episode, false, at, kind, -WORK_STEP * 4)
    this.scheduleFlush()
  }

  markCooldown(sourceKey: string, at = this.now()): void {
    const entry = this.ensureGlobal(sourceKey)
    this.replaceGlobal({
      ...entry,
      cooldownUntil: at + this.budget.failedSourceCooldownSec * 1000,
    })
    this.scheduleFlush()
  }

  updateLive(sourceKey: string, input: LiveInput): void {
    const live = this.live.get(sourceKey) ?? { playSeconds: 0, stallSeconds: 0 }
    live.playSeconds += Math.max(0, input.playSeconds ?? 0)
    live.stallSeconds += Math.max(0, input.stallSeconds ?? 0)
    this.live.set(sourceKey, live)
  }

  snapshot(workId?: string): SourceHealthSnapshot {
    const at = this.now()
    const globals = this.archive.globals.map(entry => {
      const withLive = this.withLive(entry)
      const verdict = verdictOf(withLive, at, this.cfg)
      return {
        sourceKey: entry.sourceKey,
        score: Math.max(0, verdict.rank),
        cooled: verdict.cooled,
        success: entry.success,
        failure: { ...entry.failure } as FailureCounts,
        playSeconds: withLive.playSeconds,
        stallSeconds: withLive.stallSeconds,
        startupMedian: entry.startupMedian,
        shownQuality: entry.shownQuality,
        lastFailureKind: entry.lastFailureKind,
      }
    })
    const works = this.archive.works
      .filter(work => workId === undefined || work.workId === workId)
      .map(work => ({
        workId: work.workId,
        sourceKey: work.sourceKey,
        available: work.available,
        scoreDelta: work.scoreDelta,
        lastSuccessAt: work.lastSuccessAt,
        lastFailureKind: work.lastFailureKind,
      }))
    return {
      generatedAt: at,
      config: {
        basisVersion: this.cfg.basisVersion,
        decayVersion: this.cfg.decayVersion,
        maxSwitchesPerEpisode: this.budget.maxSwitchesPerEpisode,
        minIntervalSec: this.budget.minIntervalSec,
        failedSourceCooldownSec: this.budget.failedSourceCooldownSec,
      },
      globals,
      works,
    }
  }

  scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_MS)
    this.flushTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = Promise.resolve()
      .then(() => this.performFlush())
      .catch(error => {
        console.info('[health]', 'write failed', error instanceof Error ? error.message : String(error))
      })
      .finally(() => { this.flushing = null })
    return this.flushing
  }

  private performFlush(): void {
    const globals = this.archive.globals.map(entry => this.withLive(entry))
    writeArchive(this.path, { ...this.archive, globals, writtenAt: this.now() })
    this.archive = { ...this.archive, globals }
    this.live.clear()
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }
}
