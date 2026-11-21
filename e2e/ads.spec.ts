import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, capture, playing, root, temporaryProfile, videoStatus } from './desktop'

/** Launches the app with a user-data rules file that leaves one source enabled. */
async function launchWith(source: string) {
  const profile = await temporaryProfile()
  const bundled = JSON.parse(await readFile(join(root, 'resources/play-sources.json'), 'utf8')) as { version: number; sources: Array<{ key: string; enabled: boolean }> }
  await writeFile(join(profile, 'play-sources.json'), JSON.stringify({ ...bundled, sources: bundled.sources.map(entry => ({ ...entry, enabled: entry.key === source })) }))
  return launch(profile)
}

/** Seconds of programme before each discontinuity the served playlist still has. */
async function joins(page: import('@playwright/test').Page, url: string) {
  return page.evaluate(async url => {
    const text = await (await fetch(url)).text()
    const result: number[] = []; let at = 0
    for (const line of text.split('\n')) {
      if (line.startsWith('#EXTINF:')) at += Number(line.slice(8).split(',')[0])
      else if (line === '#EXT-X-DISCONTINUITY') result.push(at)
    }
    return { joins: result, duration: at, upstreamLeak: /https?:\/\/(?!127\.0\.0\.1)/.test(text), encrypted: /#EXT-X-KEY:METHOD=AES-128/.test(text), adPaths: /adjump|ppvod/.test(text) }
  }, url)
}

// Each case is a source whose live manifests carry a different kind of ad evidence.
for (const entry of [
  { source: 'bfzy', title: '漫长的季节', type: 'tv', note: 'reserved ad path inside an implicit-IV AES-128 programme' },
  { source: '360zy', title: '流浪地球2', type: 'movie', note: 'out-of-directory blocks' },
  { source: 'dyttzy', title: '三体', type: 'tv', note: 'duration fingerprints on a rotated CDN host' },
  { source: 'lzi', title: '庆余年 第二季', type: 'tv', note: 'CMS ad marker on a rotated CDN host' },
] as const) {
  test(`ad removal on ${entry.source}: ${entry.note} plays, seeks across the cut and keeps decoding`, async () => {
    const { app, page, errors, logs } = await launchWith(entry.source)
    try {
      await page.evaluate(() => window.panda.user.dispatch({ type: 'settings', patch: { muted: true } }))
      const item = await page.evaluate(async ({ title, type }) => (await window.panda.data.search(title)).find(item => item.title === title && item.type === type), entry)
      expect(item, `${entry.title} in search`).toBeTruthy()
      await page.evaluate(id => { location.hash = '#/play/' + id + '/1' }, item!.id)
      await playing(page)
      const removal = () => logs.join('').split('\n').filter(line => line.includes('[media]') && line.includes('"reason":"filtered"'))
      await expect.poll(() => removal().length, { timeout: 20000 }).toBeGreaterThan(0)
      const diagnostic = JSON.parse(removal()[0]!.slice(removal()[0]!.indexOf('{'))) as { removedSegments: number; removedSeconds: number; evidence: string[] }
      expect(diagnostic.removedSegments).toBeGreaterThan(0)
      // The playlist the player was given: what remains, and where the cuts are.
      const playback = await page.evaluate(id => window.panda.data.playback(id, 1), item!.id)
      const served = await joins(page, playback.url)
      expect(served.upstreamLeak).toBe(false)
      expect(served.adPaths).toBe(false)
      const start = await videoStatus(page)
      expect(Math.abs(start.duration - served.duration)).toBeLessThan(3)
      const cut = served.joins.find(at => at > 30)
      expect(cut, 'a cut inside the programme').toBeTruthy()
      // Seek to just before the first cut and play through it.
      await page.evaluate(at => { document.querySelector('video')!.currentTime = at }, cut! - 4)
      await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 40000 }).toBeGreaterThan(cut! + 3)
      const across = await videoStatus(page)
      expect(across.error).toBeUndefined()
      expect(across.decodedFrames).toBeGreaterThan(start.decodedFrames)
      // Seek far past it, then back to the very start.
      await page.evaluate(at => { document.querySelector('video')!.currentTime = at }, Math.min(served.duration - 60, cut! + 600))
      await playing(page)
      await page.evaluate(() => { document.querySelector('video')!.currentTime = 0 })
      await expect.poll(() => page.evaluate(() => { const v = document.querySelector('video')!; return v.currentTime > 1 && v.currentTime < 30 && !v.paused }), { timeout: 40000 }).toBe(true)
      await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
      await capture(page, `ad-removal-${entry.source}`, { at: new Date().toISOString(), source: entry.source, title: item!.title, id: item!.id, note: entry.note, diagnostic, served: { duration: served.duration, cuts: served.joins, encrypted: served.encrypted }, start, across, end: await videoStatus(page) })
      expect(errors).toEqual([])
    } finally { await app.close() }
  })
}
