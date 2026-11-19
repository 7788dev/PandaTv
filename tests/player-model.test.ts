import { describe, expect, it } from 'vitest'
import { playbackHistory, bufferedRanges, resolutionQuality } from '../src/renderer/player-model'
import { updateResult } from '../src/main/updates'
import { rpc, safeError } from '../src/main/ipc'

describe('actual video state', () => {
  it('never invents the next episode duration and ignores invalid media metadata', () => {
    expect(playbackHistory('db-1', 1, 99, 100, true, 1000)).toEqual({ id: 'db-1', episode: 2, position: 0, duration: 0, at: 1000 })
    expect(playbackHistory('db-1', 1, 42, NaN, true)).toBeNull()
    expect(playbackHistory('db-1', 1, 42, Infinity, true)).toBeNull()
    expect(playbackHistory('db-1', 1, 42, 100, false, 1000)?.position).toBe(42)
  })
  it('represents gaps in actual buffered ranges instead of painting fictional progress', () => {
    const ranges: TimeRanges = { length: 2, start: i => [0, 50][i], end: i => [10, 60][i] }
    expect(bufferedRanges(ranges, 100)).toEqual([{ start: 0, end: 10 }, { start: 50, end: 60 }])
    expect(bufferedRanges(ranges, NaN)).toEqual([])
    expect(resolutionQuality(0, 0)).toBeUndefined()
  })
  it('does not report update success for malformed release data or leak internal errors', async () => {
    expect(updateResult('1.0.0', '1.0.1').status).toBe('available')
    expect(updateResult('1.0.1', '1.0.0').status).toBe('current')
    expect(() => updateResult('1.0.0', undefined)).toThrow()
    expect(safeError(new Error('https://upstream.example/?secret=token')).message).not.toContain('secret')
    expect(await rpc(() => { throw new Error('INVALID_INPUT') })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })
})
