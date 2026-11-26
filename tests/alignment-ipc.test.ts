import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import calibration from '../resources/rule-calibration.json'
import { parseRuleCalibration } from '../src/main/health/config'
import { SourceHealthStore } from '../src/main/health/store'
import { invokeData, type Services } from '../src/main/ipc'
import { OffsetCache } from '../src/main/playback/offset-cache'
import type { AlignInput } from '../src/shared/rules/types'

const resolved = parseRuleCalibration(calibration)
const config = resolved.alignment
const dirs: string[] = []

function services(): Services {
  const dir = mkdtempSync(join(tmpdir(), 'panda-align-ipc-'))
  dirs.push(dir)
  return {
    offsets: new OffsetCache(join(dir, 'offsets.json'), config.offsetTtlDays, config.ratioTolerance),
    alignment: config,
    buffer: resolved.buffer,
    budget: resolved.budget,
    health: new SourceHealthStore(join(dir, 'health.json'), resolved.health, resolved.budget),
  } as Services
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

const input = (elapsedMs: number): AlignInput => ({
  workId: 'db-1', episode: 1, position: 600,
  from: { sourceKey: 'a', duration: 1200, durationSource: 'hls-extinf', fingerprint: 'fp-a' },
  to: { sourceKey: 'b', duration: 1200, durationSource: 'hls-extinf', fingerprint: 'fp-b' },
  capability: 'frames', samples: [{ offsetSeconds: 1, similarity: 1, valid: true }], elapsedMs,
})

describe('alignment IPC timing contract', () => {
  it('checks persisted observations for this source and ratios from other episodes before using a cached offset', async () => {
    const client = services()
    const original = input(20)
    await invokeData('playback.align', [original], client)
    for (const seconds of [1200, 1500]) client.health!.observeDuration('db-1', 1, 'b', seconds)
    for (const episode of [2, 3, 4]) {
      client.health!.observeDuration('db-1', episode, 'a', 1200)
      client.health!.observeDuration('db-1', episode, 'b', 1201)
    }
    await client.health!.close()
    client.health = new SourceHealthStore(join(dirs.at(-1)!, 'health.json'), resolved.health, resolved.budget)
    await expect(invokeData('playback.align', [original], client)).resolves.toMatchObject({ layer: 'rejected', reason: 'history-inconsistent' })
    const outlier = { ...original, episode: 5, to: { ...original.to, duration: 1210 } }
    await expect(invokeData('playback.align', [outlier], client)).resolves.toMatchObject({ layer: 'rejected', durationJudge: { verdict: 'suspect' } })
    await expect(invokeData('playback.align', [{ ...outlier, workId: 'db-2' }], client)).resolves.toMatchObject({ verified: true })
  })

  it('preserves measured elapsed time and enforces the configured frame budget', async () => {
    const client = services()
    await expect(invokeData('playback.align', [input(config.frameBudgetMs + 1)], client)).resolves.toMatchObject({
      layer: 'degraded', reason: 'over-budget', verified: false, elapsedMs: config.frameBudgetMs + 1,
    })
    await expect(invokeData('playback.align', [input(config.frameBudgetMs)], client)).resolves.toMatchObject({
      layer: 'frame-check', verified: true, offsetSeconds: 1, elapsedMs: config.frameBudgetMs,
    })
  })

  it.each([undefined, -1, NaN, Infinity])('rejects missing or invalid elapsed time (%s)', async elapsedMs => {
    await expect(invokeData('playback.align', [{ ...input(0), elapsedMs }], services())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('exposes calibrated player rules and records observed playback metrics', async () => {
    const client = services()
    await expect(invokeData('playback.rules', [], client)).resolves.toEqual({
      alignment: resolved.alignment, buffer: resolved.buffer, budget: resolved.budget,
    })
    await expect(invokeData('sources.observe', ['a', 30, 5], client)).resolves.toBeUndefined()
    expect(client.health!.snapshot().globals).toEqual([])
    client.health!.recordSuccess('a', 'db-1', 1)
    expect(client.health!.snapshot().globals[0]).toMatchObject({ playSeconds: 30, stallSeconds: 5 })
    await expect(invokeData('sources.observe', ['a', -1, 0], client)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
