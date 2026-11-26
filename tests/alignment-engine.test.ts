import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedAlignmentConfig } from '../src/shared/rules/config'
import { align } from '../src/main/playback/alignment-engine'
import { OffsetCache } from '../src/main/playback/offset-cache'

const at = 1_760_000_000_000
const dirs: string[] = []

const config: ResolvedAlignmentConfig = {
  basisVersion: 'test',
  ratioTolerance: 0.01,
  absoluteToleranceSec: 5,
  historyConsistencyRatio: 0.05,
  workSpreadFactor: 4,
  windowSeconds: 3,
  sampleLimit: 5,
  frameBudgetMs: 1_200,
  similarityThreshold: 0.9,
  offsetTtlDays: 7,
  takeoverHeadroomFactor: 1.5,
}

function deps() {
  const dir = mkdtempSync(join(tmpdir(), 'panda-align-'))
  dirs.push(dir)
  const path = join(dir, 'offsets.json')
  return { offsets: new OffsetCache(path, config.offsetTtlDays, config.ratioTolerance, () => at), config, path }
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

const endpoint = (sourceKey: string, seconds: number | null, fingerprint?: string) => ({
  sourceKey,
  duration: seconds ?? undefined,
  durationSource: seconds === null ? 'missing' as const : 'hls-extinf' as const,
  fingerprint,
})

const input = (from: number | null, to: number | null, extra: Record<string, unknown> = {}) => ({
  workId: 'db-1',
  episode: 1,
  position: 600,
  from: endpoint('a', from, 'fp-a'),
  to: endpoint('b', to, 'fp-b'),
  history: { sourceSamples: [], workRatios: [] },
  capability: 'frames' as const,
  elapsedMs: 100,
  ...extra,
})

describe('layered alignment engine', () => {
  it('rejects a duration that looks like a different cut', () => {
    const result = align(input(1200, 1500), deps())
    expect(result.layer).toBe('rejected')
    expect(result.reason).toBe('duration-suspect')
    expect(result.offsetSeconds).toBeUndefined()
  })

  it('degrades explicitly when frames are unavailable and no offset is cached', () => {
    const result = align(input(null, 1200, { capability: 'no-frames' }), deps())
    expect(result.layer).toBe('degraded')
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('frames-unavailable')
  })

  it('uses a cached offset without asking for frames', () => {
    const dependencies = deps()
    dependencies.offsets.record({
      workId: 'db-1', episode: 1, fromSource: 'a', toSource: 'b', fingerprint: 'fp-b',
      offsetSeconds: 5, confirmedBy: 'frame-check', fromDuration: 1200, toDuration: 1200, deviation: 0,
    })
    const result = align(input(1200, 1200), dependencies)
    expect(result.layer).toBe('offset-cache')
    expect(result.offsetSeconds).toBe(5)
    expect(result.verified).toBe(true)
  })

  it('does not mark a manual offset as frame verified', () => {
    const dependencies = deps()
    dependencies.offsets.record({
      workId: 'db-1', episode: 1, fromSource: 'a', toSource: 'b', fingerprint: 'fp-b',
      offsetSeconds: 5, confirmedBy: 'manual', fromDuration: 1200, toDuration: 1200, deviation: 0,
    })
    const result = align(input(1200, 1200), dependencies)
    expect(result.layer).toBe('offset-cache')
    expect(result.verified).toBe(false)
  })

  it('asks for candidate frames when the duration is fine and nothing is cached', () => {
    const result = align(input(1200, 1200), deps())
    expect(result.layer).toBe('frame-check')
    expect(result.verified).toBe(false)
    expect(result.candidateOffsets).toEqual([0])
  })

  it('accepts a frame match inside the sampling window', () => {
    const result = align(input(1200, 1200, {
      samples: [{ offsetSeconds: 0, similarity: 1, valid: true }],
    }), deps())
    expect(result.layer).toBe('frame-check')
    expect(result.verified).toBe(true)
    expect(result.offsetSeconds).toBe(0)
    expect(result.samplesUsed).toBe(1)
  })

  it('rejects a completed check with no usable samples', () => {
    expect(align(input(1200, 1200, { samples: [] }), deps())).toMatchObject({
      layer: 'rejected', reason: 'no-match', verified: false,
    })
  })

  it('reuses a verified frame offset after reopening the cache', () => {
    const dependencies = deps()
    const result = align(input(1200, 1205, {
      samples: [{ offsetSeconds: 2, similarity: 1, valid: true }],
    }), dependencies)
    expect(result.verified).toBe(true)
    const offsets = new OffsetCache(dependencies.path, config.offsetTtlDays, config.ratioTolerance, () => at + 1000)
    const cached = align(input(1200, 1205, { capability: 'no-frames', elapsedMs: 0 }), { offsets, config })
    expect(cached).toMatchObject({ layer: 'offset-cache', offsetSeconds: 2, verified: true, samplesUsed: 0 })
    expect(offsets.lookup({
      workId: 'db-1', episode: 1, fromSource: 'a', toSource: 'b', fingerprint: 'fp-b', deviation: 5 / 1200,
    })).toMatchObject({ fromDuration: 1200, toDuration: 1205, confirmedBy: 'frame-check' })
    expect(align(input(1200, 1205, { to: endpoint('b', 1205, 'changed'), capability: 'no-frames' }), { offsets, config }).layer).toBe('degraded')
  })

  it('degrades rather than trusting an over-budget frame check', () => {
    const dependencies = deps()
    const result = align(input(1200, 1200, {
      elapsedMs: 1_201,
      samples: [{ offsetSeconds: 0, similarity: 1, valid: true }],
    }), dependencies)
    expect(result.layer).toBe('degraded')
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('over-budget')
    expect(align(input(1200, 1200, { capability: 'no-frames' }), dependencies).layer).toBe('degraded')
  })

  it('does not cache a frame mismatch', () => {
    const dependencies = deps()
    expect(align(input(1200, 1200, {
      samples: [{ offsetSeconds: 0, similarity: 0.5, valid: true }],
    }), dependencies).layer).toBe('rejected')
    expect(align(input(1200, 1200, { capability: 'no-frames' }), dependencies).layer).toBe('degraded')
  })
})
