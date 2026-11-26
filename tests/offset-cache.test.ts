import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OffsetCache } from '../src/main/playback/offset-cache'

const at = 1_760_000_000_000
const dirs: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'panda-offset-'))
  dirs.push(path)
  return path
}

function cache(path = join(directory(), 'offsets.json'), now = () => at): OffsetCache {
  return new OffsetCache(path, 7, 0.01, now)
}

const base = {
  workId: 'db-1',
  episode: 1,
  fromSource: 'a',
  toSource: 'b',
  fingerprint: 'fp-1',
  deviation: 0.001,
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('alignment offset cache', () => {
  it('returns a recorded offset and counts the hit', () => {
    const offsets = cache()
    offsets.record({ ...base, offsetSeconds: 5.04, confirmedBy: 'frame-check', fromDuration: 1200, toDuration: 1200 })
    const entry = offsets.lookup(base)
    expect(entry?.offsetSeconds).toBe(5)
    expect(entry?.hitCount).toBe(1)
  })

  it('misses when the manifest fingerprint changes', () => {
    const offsets = cache()
    offsets.record({ ...base, offsetSeconds: 5, confirmedBy: 'frame-check', fromDuration: 1200, toDuration: 1200 })
    expect(offsets.lookup({ ...base, fingerprint: 'fp-2' })).toBeUndefined()
  })

  it('misses when the episode changes', () => {
    const offsets = cache()
    offsets.record({ ...base, offsetSeconds: 5, confirmedBy: 'frame-check', fromDuration: 1200, toDuration: 1200 })
    expect(offsets.lookup({ ...base, episode: 2 })).toBeUndefined()
  })

  it('invalidates an entry whose deviation moved past the basis', () => {
    const offsets = cache()
    offsets.record({ ...base, offsetSeconds: 5, confirmedBy: 'frame-check', fromDuration: 1200, toDuration: 1200 })
    expect(offsets.lookup({ ...base, deviation: 0.5 })).toBeUndefined()
    expect(offsets.lookup(base)).toBeUndefined()
  })

  it('expires an entry after its ttl', () => {
    let now = at
    const offsets = new OffsetCache(join(directory(), 'offsets.json'), 7, 0.01, () => now)
    offsets.record({ ...base, offsetSeconds: 5, confirmedBy: 'frame-check', fromDuration: 1200, toDuration: 1200 })
    now = at + 8 * 86_400_000
    expect(offsets.lookup(base)).toBeUndefined()
  })

  it('falls back to an empty cache when the file is corrupt', () => {
    const path = join(directory(), 'offsets.json')
    writeFileSync(path, '{bad')
    expect(cache(path).lookup(base)).toBeUndefined()
    expect(existsSync(`${path}.bak`)).toBe(true)
  })

  it('keeps the cache readable after a round trip', () => {
    const path = join(directory(), 'offsets.json')
    const first = cache(path)
    first.record({ ...base, offsetSeconds: -4.5, confirmedBy: 'manual', fromDuration: 1200, toDuration: 1195 })
    first.flush()
    const second = cache(path)
    expect(second.lookup(base)?.offsetSeconds).toBe(-4.5)
    expect(second.lookup(base)?.confirmedBy).toBe('manual')
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(1)
  })
})