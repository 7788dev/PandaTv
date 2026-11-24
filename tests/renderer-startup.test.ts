import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StartupWatchdog } from '../src/renderer/startup-watchdog'
import { playbackHistory, playbackProgress } from '../src/renderer/player-model'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())

it('excludes a long pause from startup and resumes with the remaining active deadline', async () => {
  const fail = vi.fn(), watch = new StartupWatchdog(15000, fail)
  watch.setEnabled(true)
  await vi.advanceTimersByTimeAsync(4000)
  watch.setEnabled(false)
  await vi.advanceTimersByTimeAsync(120000)
  expect(fail).not.toHaveBeenCalled()
  watch.setEnabled(true)
  await vi.advanceTimersByTimeAsync(10999)
  expect(fail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(fail).toHaveBeenCalledTimes(1)
})

it('does not reset or duplicate the deadline on repeated play signals', async () => {
  const fail = vi.fn(), watch = new StartupWatchdog(15000, fail)
  watch.setEnabled(true)
  await vi.advanceTimersByTimeAsync(10000)
  watch.setEnabled(true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(fail).toHaveBeenCalledTimes(1)
  watch.setEnabled(false); watch.setEnabled(true)
  await vi.advanceTimersByTimeAsync(30000)
  expect(fail).toHaveBeenCalledTimes(1)
})

it('cleans up both a completed startup and a destroyed player', async () => {
  const fail = vi.fn()
  for (let i = 0; i < 20; i++) {
    const watch = new StartupWatchdog(15000, fail)
    watch.setEnabled(true)
    await vi.advanceTimersByTimeAsync(100)
    watch.finish(); watch.setEnabled(true)
  }
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(30000)
  expect(fail).not.toHaveBeenCalled()
})

it('keeps the current episode and resume position when playback exits before the end', () => {
  expect(playbackHistory('db-1', 3, 37.9, 120, true, 1)).toEqual({ id: 'db-1', episode: 3, position: 37, duration: 120, at: 1 })
  expect(playbackHistory('db-1', 3, 119.9, 120, true, 1)).toEqual({ id: 'db-1', episode: 4, position: 0, duration: 0, at: 1 })
  expect(playbackHistory('db-1', 3, 5, 0, true)).toBeNull()
  expect(playbackProgress(50, 50, false)).toBeUndefined()
  expect(playbackProgress(50, 51, true)).toBeUndefined()
  expect(playbackProgress(50, 51, false)).toBe(51)
})
