import { it, expect } from 'vitest'
import { WorkLimiter } from '../src/main/playback/network'
import { normalizeRange } from '../src/main/playback/proxy'
import { filterPlaylist, rewritePlaylist } from '../src/main/playback/filter'
import { loadSourceRules } from '../src/main/playback/sources'
import { readFileSync } from 'node:fs'

it('reserves a limiter slot for an already waiting request', async () => {
  const limiter = new WorkLimiter(1)
  let active = 0, max = 0, release!: () => void
  const started = new Promise<void>(resolve => { release = resolve })
  const run = async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 5)); active-- }
  let urgent: Promise<void> = Promise.resolve()
  const first = limiter.run(async () => { await started; queueMicrotask(() => { urgent = limiter.run(run) }) })
  const waiting = limiter.run(run)
  release()
  await first; await waiting; await urgent
  expect(max).toBe(1)
})
it('preserves suffix ranges needed by MP4 metadata readers', () => {
  expect(normalizeRange('bytes=-512')).toBe('bytes=-512')
})
it('does not shorten an anchored HLS timeline', () => {
  const rules = loadSourceRules(), source = rules.sources.find(s => s.key === 'ffzy')!
  const original = readFileSync(new URL('../docs/evidence/manifest-ffzy-1.m3u8', import.meta.url), 'utf8')
  const anchored = original.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=120')
  expect(filterPlaylist(anchored, new URL('https://vip.ffzy-online2.com/index.m3u8'), source, rules).text).toBe(anchored)
})
it('does not expose source comments to the renderer', () => {
  const output = rewritePlaylist('#EXTM3U\n# source https://private.example/?token=123\n#EXTINF:2,\nclip.ts\n', new URL('https://cdn.example/playlist.m3u8'), () => '/asset/opaque')
  expect(output).not.toContain('token')
})
