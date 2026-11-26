import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { choose, clickPlayerControl, clickPlayerLocator, contrast, fixtureDesktop, openFixturePlayer, playing, resize, screenshot } from './quality-desktop'
import { t } from '../src/contract/copy'
import { extra } from '../src/copy.extra'

let desktop: Awaited<ReturnType<typeof fixtureDesktop>>
test.beforeEach(async ({}, info) => { desktop = await fixtureDesktop(info.title.replace(/[^a-z0-9]/gi, '-').slice(0, 60)) })
test.afterEach(async ({}, info) => {
  if (!desktop) return
  if (info.status !== info.expectedStatus) await screenshot(desktop.page, join(desktop.dir, 'failure.png')).catch(() => {})
  try { expect(desktop.errors).toEqual([]) } finally { await desktop.close() }
})

test('actual settings, channel layout and modal controls remain readable at supported window sizes and zoom', async () => {
  const { app, page, dir } = desktop
  await page.locator('a[href="#/settings"]').click()
  const measurements = []
  for (const [width, height, zoom] of [[1080, 640, 1], [1440, 900, 1], [1440, 900, 1.25], [1920, 1080, 1.5]]) {
    await resize(app, width, height, zoom)
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    const state = await page.evaluate(() => {
      const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
      const controls = [...document.querySelectorAll<HTMLElement>('.topbar a,.topbar button,.settings__body button')].filter(e => e.getBoundingClientRect().width > 0)
      return { viewport: [innerWidth, innerHeight], horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        titleSize: parseFloat(getComputedStyle(document.querySelector('.page__title')!).fontSize),
        controls: controls.map(e => { const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return { label: e.getAttribute('aria-label') || e.textContent, rect: rect(e), font: getComputedStyle(e).fontSize, hittable: y >= innerHeight || Boolean(e.contains(document.elementFromPoint(x, y))) } }) }
    })
    expect(state.horizontalOverflow).toBe(false)
    expect(state.titleSize).toBeGreaterThanOrEqual(28)
    expect(state.controls.every(control => control.rect.x >= 0 && control.rect.x + control.rect.width <= state.viewport[0] + 1 && control.hittable)).toBe(true)
    measurements.push({ width, height, zoom, ...state })
    await screenshot(page, join(dir, `settings-${width}-${zoom}.png`))
  }
  await resize(app, 1080, 640)
  await page.getByRole('switch', { name: '自动播放下一集' }).click()
  await page.getByRole('button', { name: t.settings.quality, exact: true }).click()
  await page.getByRole('menuitemradio', { name: '720P', exact: true }).click()
  await page.locator('a[href="#/channel/movie"]').click()
  await page.locator('.grid .card').first().waitFor()
  const cards = await page.locator('.grid .card').evaluateAll(cards => cards.slice(0, 6).map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width } }))
  expect(cards.length).toBe(6)
  for (let i = 1; i < cards.length; i++) expect(cards[i].x - cards[i - 1].x - cards[i - 1].width).toBeGreaterThanOrEqual(8)
  await screenshot(page, join(dir, 'channel-small.png'))
  writeFileSync(join(dir, 'layout.json'), JSON.stringify({ measurements, cards }, null, 2))
})

test('watched numbers and titled episodes remain readable and actionable in the actual detail and drawer', async () => {
  const { page, dir } = desktop
  await page.evaluate(async () => { await window.panda.user.dispatch({ type: 'history:record', entry: { id: 'db-2001', episode: 2, position: 35, duration: 120, at: Date.now() } }); location.hash = '#/detail/db-2001' })
  const watched = page.locator('.ep[data-watched]').first()
  await watched.waitFor()
  const detail = await contrast(watched)
  expect(detail.ratio).toBeGreaterThanOrEqual(4.5)
  expect(parseFloat(detail.fontSize)).toBeGreaterThanOrEqual(13)
  await watched.hover()
  await expect.poll(async () => (await contrast(watched)).ratio).toBeGreaterThanOrEqual(4.5)
  const hover = await contrast(watched)
  await page.mouse.move(1, 1)
  await watched.focus()
  const focused = await contrast(watched)
  expect(focused.ratio).toBeGreaterThanOrEqual(4.5)
  await watched.click()
  await playing(page)
  await clickPlayerControl(page, '选集')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]')))).toBe(true)
  await screenshot(page, join(dir, 'episode-drawer.png'))
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '选集', exact: true })).toBeFocused()
  await clickPlayerControl(page, '返回')
  await page.evaluate(async () => { await window.panda.user.dispatch({ type: 'history:record', entry: { id: 'db-2002', episode: 2, position: 35, duration: 120, at: Date.now() } }); location.hash = '#/detail/db-2002' })
  const named = page.locator('.eplist__item[data-watched]').first()
  await named.waitFor()
  await expect(named).toContainText('序章')
  const number = await contrast(named.locator('.eplist__num'))
  const title = await contrast(named.locator('.eplist__title'))
  expect(number.ratio).toBeGreaterThanOrEqual(4.5)
  expect(title.ratio).toBeGreaterThanOrEqual(4.5)
  await named.hover()
  await expect.poll(async () => (await contrast(named.locator('.eplist__num'))).ratio).toBeGreaterThanOrEqual(4.5)
  await screenshot(page, join(dir, 'watched-named-hover.png'))
  writeFileSync(join(dir, 'watched-contrast.json'), JSON.stringify({ detail, hover, focused, namedNumber: number, namedTitle: title }, null, 2))
})

test('a fully buffered film reaches ended on its original source', async () => {
  const { page, dir } = desktop
  await openFixturePlayer(page, 'db-1001')
  const source = await page.evaluate(() => window.panda.data.sources('db-1001', 1).then(s => s.current))
  await page.locator('.player__video').evaluate(node => {
    const video = node as HTMLVideoElement
    video.currentTime = video.duration - 9
  })
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('.player__video')?.ended, undefined, { timeout: 25000 })
  expect(await page.evaluate(() => window.panda.data.sources('db-1001', 1).then(s => s.current))).toBe(source)
  await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
  await screenshot(page, join(dir, 'buffered-ending.png'))
})

test('a switch preserves the seek made while its probe is pending', async () => {
  const { page, dir, network } = desktop
  await openFixturePlayer(page, 'db-1001')
  const info = await page.evaluate(() => window.panda.data.sources('db-1001', 1))
  const target = info.list.find(line => line.key !== 'a' && line.key !== info.current)!
  // A previously verified zero offset exercises the normal cache-hit path on the next switch.
  const seeded = await page.evaluate(async ([from, to]) => {
    const duration = document.querySelector<HTMLVideoElement>('.player__video')!.duration
    const endpoint = (sourceKey: string) => ({ sourceKey, duration, durationSource: 'mp4-moov' as const })
    return window.panda.data.align({ workId: 'db-1001', episode: 1, position: 1, from: endpoint(from), to: endpoint(to),
      capability: 'frames', samples: [{ offsetSeconds: 0, valid: true, similarity: 1 }], elapsedMs: 100 })
  }, [info.current!, target.key])
  expect(seeded.verified).toBe(true)
  const release = network.holdProbe(target.key)
  const original = await page.locator('.player__video').evaluate(node => (node as HTMLVideoElement).currentSrc)
  try {
    await choose(page, '线路', target.name)
    await page.locator('.seek').focus()
    await page.keyboard.press('PageUp')
    await playing(page, 60)
  } finally { release() }
  await page.waitForFunction(src => {
    const video = document.querySelector<HTMLVideoElement>('.player__video')
    return video && video.currentSrc && video.currentSrc !== src && !video.paused && video.currentTime >= 60
  }, original)
  expect(await page.evaluate(() => window.panda.data.sources('db-1001', 1).then(s => s.current))).toBe(target.key)
  await screenshot(page, join(dir, 'switch-after-seek.png'))
})

test('rejecting a different cut leaves the original video and source selection active', async () => {
  const { page, network, dir } = desktop
  await openFixturePlayer(page)
  const info = await page.evaluate(() => window.panda.data.sources('db-2001', 1))
  const target = info.list.find(line => line.key !== 'a' && line.key !== info.current)!
  network.state.shortPlaylist = target.key
  const original = await page.locator('.player__video').evaluate(node => (node as HTMLVideoElement).currentSrc)
  await choose(page, '线路', target.name)
  await page.getByText(extra.lineSwitchFailed, { exact: true }).first().waitFor()
  expect(await page.evaluate(() => window.panda.data.sources('db-2001', 1).then(s => s.current))).toBe(info.current)
  expect(await page.locator('.player__video').evaluate(node => (node as HTMLVideoElement).currentSrc)).toBe(original)
  await playing(page)
  await screenshot(page, join(dir, 'rejected-cut.png'))
})

test('focused seek arrows and page keys seek without consuming global volume shortcuts', async () => {
  const { page, dir } = desktop
  await openFixturePlayer(page, 'db-1001')
  await clickPlayerLocator(page, page.locator('.player__play'))
  const slider = page.locator('.seek')
  await slider.focus()
  const before = await page.locator('video').evaluate(v => ({ at: (v as HTMLVideoElement).currentTime, volume: (v as HTMLVideoElement).volume }))
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(before.at + 8)
  expect(await page.locator('video').evaluate(v => (v as HTMLVideoElement).volume)).toBe(before.volume)
  await page.keyboard.press('PageUp')
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(before.at + 65)
  await page.keyboard.press('Home')
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeLessThan(.5)
  await screenshot(page, join(dir, 'seek-focused.png'))
  await page.locator('.player__play').focus()
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).volume)).toBeGreaterThan(before.volume)
})

test('a pause before the first video frame survives the startup deadline and resumes normally', async () => {
  const { page, network, dir } = desktop
  network.state.holdPlayback = true
  await page.evaluate(() => { location.hash = '#/detail/db-1001' })
  await page.locator('.detail__actions a[href^="#/play/db-1001"]').click()
  const pause = page.getByRole('button', { name: '暂停', exact: true })
  await pause.waitFor({ timeout: 30000 })
  await expect(pause).toBeEnabled()
  await clickPlayerLocator(page, pause)
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).paused)).toBe(true)
  const probes = network.calls.filter(call => call.range === 'bytes=0-16383').length
  await page.waitForTimeout(17000)
  expect(network.calls.filter(call => call.range === 'bytes=0-16383').length).toBe(probes)
  await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
  await screenshot(page, join(dir, 'paused-before-first-frame.png'))
  network.releasePlayback()
  await clickPlayerLocator(page, page.locator('.player__play'))
  await playing(page)
  writeFileSync(join(dir, 'paused-startup.json'), JSON.stringify({ pausedMs: 17000, probesBefore: probes, probesAfter: network.calls.filter(call => call.range === 'bytes=0-16383').length }, null, 2))
})

test('loading icon controls have native disabled state and become usable after media arrives', async () => {
  const { page, network } = desktop
  network.state.holdPlayback = true
  await page.evaluate(() => { location.hash = '#/detail/db-1001' })
  await page.locator('.detail__actions a[href^="#/play/db-1001"]').click()
  await page.locator('video').waitFor({ state: 'attached' })
  const play = page.locator('.player__play')
  await expect(play).toBeEnabled()
  await expect(page.getByRole('button', { name: '画中画', exact: true })).toBeDisabled()
  await clickPlayerLocator(page, play)
  await expect(play).toHaveAttribute('aria-label', '播放')
  network.releasePlayback()
  await clickPlayerLocator(page, play)
  await playing(page)
  await expect(play).toBeEnabled()
  await clickPlayerLocator(page, play)
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).paused)).toBe(true)
})

test('failed manual source falls back while preserving playback position and correct source selection', async () => {
  const { page, network, dir } = desktop
  await openFixturePlayer(page, 'db-1001')
  await page.locator('.seek').focus(); await page.keyboard.press('PageUp')
  await playing(page, 60)
  const before = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)
  await choose(page, '线路', '线路甲')
  await playing(page, before - 1)
  await expect.poll(() => page.evaluate(() => window.panda.data.sources('db-1001', 1).then(value => value.current)), { timeout: 20000 }).toBe('c')
  await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
  await screenshot(page, join(dir, 'source-fallback.png'))
  writeFileSync(join(dir, 'source-fallback.json'), JSON.stringify({ before, after: await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime), source: await page.evaluate(() => window.panda.data.sources('db-1001', 1)), probes: network.calls.filter(call => call.range === 'bytes=0-16383') }, null, 2))
})

test('real HLS decoding completes episode source seek exit and resume transitions', async () => {
  const { page, app, dir, network } = desktop
  await openFixturePlayer(page)
  expect((await page.evaluate(() => window.panda.data.availability('db-2001'))).episodes).toBe(3)
  expect(network.calls.some(call => /bonus|episode-9/.test(call.path))).toBe(false)
  expect(await page.locator('video').evaluate(v => (v as HTMLVideoElement).videoWidth)).toBe(1920)
  await clickPlayerControl(page, '下一集')
  await playing(page)
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/play/db-2001/2')
  await choose(page, '线路', '线路乙')
  await playing(page)
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).videoWidth)).toBe(1280)
  await page.locator('.seek').focus(); await page.keyboard.press('PageUp')
  await playing(page, 60)
  await page.keyboard.press('f')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true)
  await screenshot(page, join(dir, 'fullscreen-playing.png'))
  await page.keyboard.press('Escape')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false)
  await clickPlayerControl(page, '返回')
  await page.locator('.detail__actions').waitFor()
  const history = await page.evaluate(() => window.panda.user.get().then(value => value.history.find(entry => entry.id === 'db-2001')))
  expect(history?.episode).toBe(2); expect(history!.position).toBeGreaterThanOrEqual(59)
  await page.locator('.detail__actions a[href^="#/play/db-2001"]').click()
  await playing(page, 59)
  expect(await page.locator('video').evaluate(v => (v as HTMLVideoElement).videoWidth)).toBe(1280)
  writeFileSync(join(dir, 'playback-cycle.json'), JSON.stringify({ history, quality: await page.locator('video').evaluate(v => ({ frames: (v as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames, dropped: (v as HTMLVideoElement).getVideoPlaybackQuality().droppedVideoFrames })) }, null, 2))
})

test('offline metadata becomes an actionable error and retry returns results with keyboard focus', async () => {
  const { page, network, dir } = desktop
  network.state.metadataOffline = true
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('回归')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '重试', exact: true }).waitFor({ timeout: 45000 })
  await expect(page.getByText('没有找到相关内容', { exact: true })).toHaveCount(0)
  await screenshot(page, join(dir, 'offline-search.png'))
  network.state.metadataOffline = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.locator('a[href="#/detail/db-2001"]').first().waitFor({ timeout: 30000 })
  await screenshot(page, join(dir, 'search-recovered.png'))
})

test('search suggestions modal cancellation and favorite state use real IPC and persist across reload', async () => {
  const { page, dir } = desktop
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('回归')
  await page.locator('.suggest__item').first().waitFor()
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await page.locator('.detail__actions').waitFor()
  await page.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(page.getByRole('button', { name: '已收藏', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '已收藏', exact: true })).toBeVisible()
  await page.locator('a[href="#/settings"]').click()
  await page.getByRole('button', { name: '清空', exact: true }).first().click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await screenshot(page, join(dir, 'confirmation-cancelled.png'))
})

test('repeated actual playback exits release video nodes and keep document and window listeners stable', async () => {
  const { page, dir } = desktop
  const cdp = await page.context().newCDPSession(page)
  const listeners = async () => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(Object.fromEntries([ ["window", window], ["document", document] ].map(([name, node]) => [name, Object.fromEntries(Object.entries(getEventListeners(node)).sort(([a], [b]) => a.localeCompare(b)).map(([type, list]) => [type, list.length]))])))',
      includeCommandLineAPI: true, returnByValue: true,
    })
    expect(result.exceptionDetails).toBeUndefined()
    return JSON.parse(result.result.value as string) as Record<string, Record<string, number>>
  }
  const open = async (episode: number) => {
    await page.evaluate(() => { location.hash = '#/detail/db-2001' })
    await page.locator('.detail__actions').waitFor()
    await page.locator(`a[href="#/play/db-2001/${episode}"]`).last().click()
    await playing(page)
  }
  const exit = async () => {
    await clickPlayerControl(page, '返回')
    await page.locator('.detail__actions').waitFor()
    expect(await page.locator('video').count()).toBe(0)
    await page.locator('a[href="#/settings"]').click()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.evaluate(() => { location.hash = '#/detail/db-2001' })
    await page.locator('.detail__actions').waitFor()
    await page.waitForTimeout(400)
    await cdp.send('HeapProfiler.collectGarbage')
  }
  try {
    // Establish the normal listener set after the first real mount and cleanup.
    await open(1); await exit()
    const baseline = await listeners()
    const samples = []
    for (let cycle = 0; cycle < 6; cycle++) {
      const episode = cycle % 2 + 1
      await open(episode)
      await page.evaluate(() => {
        const observer = window as unknown as { qualityDetachedNodes?: WeakRef<Element>[] }
        observer.qualityDetachedNodes ??= []
        for (const node of [document.querySelector('video'), document.querySelector('.player')]) {
          if (node) observer.qualityDetachedNodes.push(new WeakRef(node))
        }
      })
      await exit()
      await cdp.send('HeapProfiler.collectGarbage')
      const retained = await page.evaluate(() => (window as unknown as { qualityDetachedNodes: WeakRef<Element>[] }).qualityDetachedNodes.map(ref => Boolean(ref.deref())))
      const current = await listeners()
      expect(retained.every(value => !value)).toBe(true)
      expect(current).toEqual(baseline)
      samples.push({ cycle: cycle + 1, episode, retained, listeners: current, heap: await cdp.send('Runtime.getHeapUsage') })
    }
    writeFileSync(join(dir, 'playback-resources.json'), JSON.stringify({ baseline, cycles: 6, samples,
      scope: 'Same renderer, alternating episodes, native cleanup and explicit GC. Finite retention evidence, not proof of all-duration memory behavior.' }, null, 2))
  } finally { await cdp.detach() }
})
