import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceHealthStore } from '../src/main/health/store'
import { resolveBudgetConfig, resolveHealthConfig } from '../src/shared/rules/config'

const cfg = resolveHealthConfig({
  basisVersion: 'test',
  decayVersion: '1',
  halfLifeDays: 30,
  baseline: 0.5,
  slowStartupSec: 8,
  playFloorSec: 60,
  workDeltaMax: 0.2,
  weights: { availability: 0.4, stability: 0.3, speed: 0.2, quality: 0.1 },
})
const budget = resolveBudgetConfig({ maxSwitchesPerEpisode: 3, minIntervalSec: 30, failedSourceCooldownSec: 300 })
const at = 1_760_000_000_000
const dirs: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'panda-health-'))
  dirs.push(path)
  return path
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('source health store', () => {
  it('keeps a cooldown across restarts', async () => {
    const path = join(directory(), 'source-health-v1.json')
    const first = new SourceHealthStore(path, cfg, budget, () => at)
    first.recordFailure('ffzy', 'stall', 'db-1', 1, at)
    await first.flush()
    const second = new SourceHealthStore(path, cfg, budget, () => at + 1_000)
    expect(second.rankFor('ffzy', 'db-1').cooled).toBe(true)
    await second.flush()
  })

  it('records a success and a failure without mixing them up', async () => {
    const store = new SourceHealthStore(join(directory(), 'health.json'), cfg, budget, () => at)
    store.recordSuccess('a', 'db-1', 1, at)
    for (let index = 0; index < 3; index += 1) store.recordFailure('b', 'stall', 'db-1', 1, at)
    expect(store.rankFor('a', 'db-1').rank).toBeGreaterThan(store.rankFor('b', 'db-1').rank)
    await store.flush()
  })

  it('lowers the rank when live playback shows stalling', async () => {
    const store = new SourceHealthStore(join(directory(), 'health.json'), cfg, budget, () => at)
    store.recordSuccess('a', 'db-1', 1, at)
    const before = store.rankFor('a', 'db-1').rank
    store.updateLive('a', { playSeconds: 60, stallSeconds: 30 })
    expect(store.rankFor('a', 'db-1').rank).toBeLessThan(before)
    await store.flush()
  })

  it('persists live totals and scores without counting repeated flushes twice', async () => {
    const path = join(directory(), 'health.json')
    const store = new SourceHealthStore(path, cfg, budget, () => at)
    store.recordSuccess('a', 'db-1', 1, at)
    store.updateLive('a', { playSeconds: 600, stallSeconds: 300 })
    const before = store.snapshot()
    await store.flush()
    await store.flush()
    expect(store.snapshot()).toEqual(before)
    expect(new SourceHealthStore(path, cfg, budget, () => at).snapshot()).toEqual(before)

    store.updateLive('a', { playSeconds: 60, stallSeconds: 10 })
    await store.close()
    const reopened = new SourceHealthStore(path, cfg, budget, () => at)
    expect(reopened.snapshot()).toEqual(store.snapshot())
    expect(reopened.snapshot().globals[0]).toMatchObject({ playSeconds: 660, stallSeconds: 310 })
    await reopened.close()
  })

  it('retains live totals when a failed write is retried', async () => {
    const blocked = join(directory(), 'blocked')
    writeFileSync(blocked, 'not a directory')
    const path = join(blocked, 'health.json')
    const store = new SourceHealthStore(path, cfg, budget, () => at)
    store.recordSuccess('a', 'db-1', 1, at)
    store.updateLive('a', { playSeconds: 60, stallSeconds: 30 })
    await store.flush()
    rmSync(blocked)
    await store.close()
    const reopened = new SourceHealthStore(path, cfg, budget, () => at)
    expect(reopened.snapshot().globals[0]).toMatchObject({ playSeconds: 60, stallSeconds: 30 })
    expect(reopened.snapshot()).toEqual(store.snapshot())
    await reopened.close()
  })

  it('starts empty and keeps a backup when the archive is corrupt', async () => {
    const path = join(directory(), 'source-health-v1.json')
    writeFileSync(path, '{not json')
    const store = new SourceHealthStore(path, cfg, budget)
    expect(store.snapshot().globals).toEqual([])
    expect(existsSync(`${path}.bak`)).toBe(true)
  })

  it('leaves an unsupported version untouched and backs it up', async () => {
    const dir = directory()
    const path = join(dir, 'source-health-v1.json')
    const original = JSON.stringify({ version: 2, globals: [], works: [] })
    writeFileSync(path, original)
    const store = new SourceHealthStore(path, cfg, budget)
    expect(store.snapshot().globals).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readdirSync(dir).some(name => name.startsWith('source-health-v1.json.unsupported-'))).toBe(true)
  })

  it('never writes the user state file', async () => {
    const dir = directory()
    const userPath = join(dir, 'user-v1.json')
    writeFileSync(userPath, '{"favorites":[]}')
    const store = new SourceHealthStore(join(dir, 'source-health-v1.json'), cfg, budget, () => at)
    store.recordSuccess('a', 'db-1', 1, at)
    await store.flush()
    expect(readFileSync(userPath, 'utf8')).toBe('{"favorites":[]}')
  })

  it('does not reject the caller when the archive cannot be written', async () => {
    const blocked = join(directory(), 'blocked')
    writeFileSync(blocked, 'not a directory')
    const store = new SourceHealthStore(join(blocked, 'health.json'), cfg, budget, () => at)
    store.recordSuccess('a', 'db-1', 1, at)
    await expect(store.flush()).resolves.toBeUndefined()
  })
})
