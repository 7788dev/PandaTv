import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const player = readFileSync(resolve('src/renderer/Player.tsx'), 'utf8')

const between = (start: string, end: string) => {
  const from = player.indexOf(start)
  const to = player.indexOf(end)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return player.slice(from, to)
}

describe('released player policy', () => {
  it('prepares the next episode only inside the last ninety seconds', () => {
    expect(player).toContain('const PREPARE_NEXT_SECONDS = 90')
    expect(player).toContain('v.duration - v.currentTime <= PREPARE_NEXT_SECONDS')
    expect(player).toContain('if (!prepared.current && v.duration > 0')
    expect(player).toContain('window.panda.data.playback(item.id, episode + 1, wantedQuality(current.settings))')
  })

  it('keeps the released forward and back buffer budget', () => {
    expect(player).toContain('maxBufferLength: 90')
    expect(player).toContain('maxMaxBufferLength: 180')
    expect(player).toContain('maxBufferSize: 96 * 1000 * 1000')
    expect(player).toContain('backBufferLength: 30')
    expect(player).toContain('maxBufferHole: 0.2')
    expect(player).toContain('capLevelToPlayerSize: true')
    expect(player).toContain('startFragPrefetch: true')
  })

  it('locks manifest and playlist load retry budgets', () => {
    const manifest = between('manifestLoadPolicy:', 'playlistLoadPolicy:')
    expect(manifest).toContain('maxTimeToFirstByteMs: 8_000')
    expect(manifest).toContain('maxLoadTimeMs: 15_000')
    expect(manifest).toContain('timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 }')
    expect(manifest).toContain('errorRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 4_000 }')

    const playlist = between('playlistLoadPolicy:', 'fragLoadPolicy:')
    expect(playlist).toContain('maxTimeToFirstByteMs: 8_000')
    expect(playlist).toContain('maxLoadTimeMs: 15_000')
    expect(playlist).toContain('timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 }')
    expect(playlist).toContain('errorRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4_000 }')
  })

  it('locks the fragment load retry budget', () => {
    const frag = player.slice(player.indexOf('fragLoadPolicy:'))
    expect(frag).toContain('maxTimeToFirstByteMs: 10_000')
    expect(frag).toContain('maxLoadTimeMs: 45_000')
    expect(frag).toContain('timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 }')
    expect(frag).toContain('errorRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 8_000 }')
  })
})