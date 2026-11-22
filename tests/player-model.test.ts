import { describe, expect, it } from 'vitest'
import { playbackHistory, bufferedRanges, playbackProgress, qualityLevelIndex, resolutionQuality } from '../src/renderer/player-model'
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
  it('only treats real media movement as progress for the stall watchdog', () => {
    expect(playbackProgress(10, 10.02, false)).toBeUndefined()
    expect(playbackProgress(10, 12, false)).toBe(12)
    expect(playbackProgress(300, 5, false)).toBe(5)
    expect(playbackProgress(10, 12, true)).toBeUndefined()
    expect(playbackProgress(-1, 0.5, false)).toBe(0.5)
    expect(playbackProgress(10, NaN, false)).toBeUndefined()
  })
  it('caps the picture at the highest-bitrate level the source really carries', () => {
    const levels = [{ quality: '720P' as const, index: 0, bitrate: 1_000_000 }, { quality: '1080P' as const, index: 1, bitrate: 3_000_000 }, { quality: '1080P' as const, index: 2, bitrate: 5_000_000 }]
    expect(qualityLevelIndex(levels, '1080P')).toBe(2)
    expect(qualityLevelIndex(levels, '4K')).toBeUndefined()
    expect(qualityLevelIndex(levels, undefined)).toBeUndefined()
  })
  it('does not report update success for malformed release data or leak internal errors', async () => {
    expect(updateResult('1.0.0', '1.0.1').status).toBe('available')
    expect(updateResult('1.0.1', '1.0.0').status).toBe('current')
    expect(() => updateResult('1.0.0', undefined)).toThrow()
    expect(safeError(new Error('https://upstream.example/?secret=token')).message).not.toContain('secret')
    expect(await rpc(() => { throw new Error('INVALID_INPUT') })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })
})
