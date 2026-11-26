import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface OffsetEntry {
  key: string
  workId: string
  episode: number
  fromSource: string
  toSource: string
  manifestFingerprint: string
  offsetSeconds: number
  confirmedBy: 'frame-check' | 'manual'
  writtenAt: number
  expiresAt: number
  fromDuration: number
  toDuration: number
  deviation: number
  hitCount: number
  lastUsedAt: number
}

export interface OffsetArchive {
  version: 1
  writtenAt: number
  atomicMarker: string
  entries: OffsetEntry[]
}

export interface OffsetLookup {
  workId: string
  episode: number
  fromSource: string
  toSource: string
  fingerprint: string
  deviation: number
}

export interface OffsetRecord extends OffsetLookup {
  offsetSeconds: number
  confirmedBy: OffsetEntry['confirmedBy']
  fromDuration: number
  toDuration: number
}

const LIMIT = 2000
const DAY_MS = 86_400_000

const cacheKey = (input: OffsetLookup): string =>
  [input.workId, input.episode, input.fromSource, input.toSource, input.fingerprint].join('|')

function empty(): OffsetArchive {
  return { version: 1, writtenAt: Date.now(), atomicMarker: 'panda-align-offsets-v1', entries: [] }
}

export function parseOffsetArchive(text: string): OffsetArchive {
  const root = JSON.parse(text) as Record<string, unknown>
  if (root.version !== 1 || !Array.isArray(root.entries)) throw new Error('OFFSET_ARCHIVE_CORRUPT')
  return {
    version: 1,
    writtenAt: typeof root.writtenAt === 'number' ? root.writtenAt : Date.now(),
    atomicMarker: 'panda-align-offsets-v1',
    entries: root.entries.flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const row = value as Record<string, unknown>
      if (typeof row.key !== 'string' || typeof row.workId !== 'string' || typeof row.fromSource !== 'string' || typeof row.toSource !== 'string') return []
      const offset = Number(row.offsetSeconds)
      if (!Number.isFinite(offset)) return []
      return [{
        key: row.key,
        workId: row.workId,
        episode: Number.isFinite(Number(row.episode)) ? Number(row.episode) : 1,
        fromSource: row.fromSource,
        toSource: row.toSource,
        manifestFingerprint: typeof row.manifestFingerprint === 'string' ? row.manifestFingerprint : '',
        offsetSeconds: Math.round(offset * 10) / 10,
        confirmedBy: (row.confirmedBy === 'manual' ? 'manual' : 'frame-check') as OffsetEntry['confirmedBy'],
        writtenAt: Number.isFinite(Number(row.writtenAt)) ? Number(row.writtenAt) : Date.now(),
        expiresAt: Number.isFinite(Number(row.expiresAt)) ? Number(row.expiresAt) : Date.now(),
        fromDuration: Math.max(0, Number(row.fromDuration) || 0),
        toDuration: Math.max(0, Number(row.toDuration) || 0),
        deviation: Math.max(0, Number(row.deviation) || 0),
        hitCount: Math.max(0, Number(row.hitCount) || 0),
        lastUsedAt: Number.isFinite(Number(row.lastUsedAt)) ? Number(row.lastUsedAt) : Date.now(),
      }]
    }).slice(0, LIMIT),
  }
}

export class OffsetCache {
  private archive: OffsetArchive

  constructor(
    private readonly path: string,
    private readonly ttlDays: number,
    private readonly tolerance: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.archive = this.read()
  }

  private read(): OffsetArchive {
    if (!existsSync(this.path)) return empty()
    try {
      return parseOffsetArchive(readFileSync(this.path, 'utf8'))
    } catch {
      try { copyFileSync(this.path, `${this.path}.bak`) } catch { /* Keep running with an empty cache. */ }
      return empty()
    }
  }

  lookup(input: OffsetLookup): OffsetEntry | undefined {
    const at = this.now()
    const key = cacheKey(input)
    const entry = this.archive.entries.find(item => item.key === key)
    if (!entry) return undefined
    if (entry.expiresAt <= at || Math.abs(input.deviation - entry.deviation) > this.tolerance) {
      this.archive.entries = this.archive.entries.filter(item => item !== entry)
      this.save()
      return undefined
    }
    entry.hitCount += 1
    entry.lastUsedAt = at
    this.save()
    return entry
  }

  record(input: OffsetRecord): OffsetEntry {
    const at = this.now()
    const entry: OffsetEntry = {
      key: cacheKey(input),
      workId: input.workId,
      episode: input.episode,
      fromSource: input.fromSource,
      toSource: input.toSource,
      manifestFingerprint: input.fingerprint,
      offsetSeconds: Math.round(input.offsetSeconds * 10) / 10,
      confirmedBy: input.confirmedBy,
      writtenAt: at,
      expiresAt: at + this.ttlDays * DAY_MS,
      fromDuration: input.fromDuration,
      toDuration: input.toDuration,
      deviation: input.deviation,
      hitCount: 0,
      lastUsedAt: at,
    }
    this.archive.entries = this.archive.entries.filter(item => item.key !== entry.key)
    this.archive.entries.push(entry)
    if (this.archive.entries.length > LIMIT) {
      this.archive.entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      this.archive.entries = this.archive.entries.slice(this.archive.entries.length - LIMIT)
    }
    this.save()
    return entry
  }

  invalidate(workId: string, episode: number, fromSource: string, toSource: string): void {
    this.archive.entries = this.archive.entries.filter(item =>
      !(item.workId === workId && item.episode === episode && item.fromSource === fromSource && item.toSource === toSource),
    )
    this.save()
  }

  flush(): void {
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({ ...this.archive, writtenAt: this.now() }), { mode: 0o600, flag: 'wx', flush: true })
        try {
          renameSync(temporary, this.path)
        } catch (error) {
          if (!existsSync(this.path)) throw error
          const rollback = `${this.path}.${randomUUID()}.rollback`
          renameSync(this.path, rollback)
          try { renameSync(temporary, this.path) }
          catch (replaceError) { renameSync(rollback, this.path); throw replaceError }
          unlinkSync(rollback)
        }
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    } catch {
      /* Offset memory is a hint; playback must continue when it cannot be stored. */
    }
  }
}