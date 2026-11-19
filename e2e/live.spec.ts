import { test, expect } from '@playwright/test'
import { launch, capture, playing, videoStatus } from './desktop'

test('real movie decodes, seeks, changes speed, enters fullscreen and persists history', async () => {
  const run = await launch()
  const { app, page } = run
  let didClose = false
  const evidence: Record<string, unknown> = { at: new Date().toISOString() }
  try {
    await page.evaluate(() => window.panda.user.dispatch({ type: 'settings', patch: { muted: true } }))
    await page.evaluate(() => { location.hash = '#/detail/db-35267208' })
    await expect(page.locator('.detail__title')).toHaveText('流浪地球2')
    await page.getByRole('button', { name: '收藏', exact: true }).click()
    await expect(page.getByRole('button', { name: '已收藏', exact: true })).toBeVisible()
    await page.locator('.detail__actions a').click()
    await playing(page)
    evidence.start = await videoStatus(page)
    expect((evidence.start as { duration: number }).duration).toBeGreaterThan(3600)
    await page.mouse.move(700, 840)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
    evidence.pause = await videoStatus(page)
    const before = (evidence.pause as { position: number }).position
    await page.locator('.player__bigplay').click()
    await playing(page)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(before + 9)
    const duration = await page.evaluate(() => document.querySelector('video')!.duration)
    const bounds = (await page.locator('.seek').boundingBox())!
    await page.mouse.click(bounds.x + bounds.width * 500 / duration, bounds.y + bounds.height / 2)
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 25000 }).toBeGreaterThan(501)
    evidence.seek = await videoStatus(page)
    await page.getByRole('button', { name: '倍速', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '1.5×', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.playbackRate)).toBe(1.5)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.panda.window.getState())).toEqual({ maximized: false, fullscreen: true })
    evidence.fullscreen = await page.evaluate(() => window.panda.window.getState())
    await page.mouse.move(600, 600)
    await page.getByRole('button', { name: '退出全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.panda.window.getState())).toEqual({ maximized: false, fullscreen: false })
    await page.mouse.move(700, 840)
    if (await page.getByRole('button', { name: '画中画', exact: true }).isVisible()) {
      await page.getByRole('button', { name: '画中画', exact: true }).click()
      await expect.poll(() => page.evaluate(() => Boolean(document.pictureInPictureElement))).toBe(true)
      evidence.pictureInPicture = true
      await page.evaluate(() => document.exitPictureInPicture())
    }
    await capture(page, 'movie-controls', { ...evidence, status: await videoStatus(page) })
    // Exercise the app's actual close button and preload progress flush.
    const closed = app.waitForEvent('close')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await closed
    didClose = true
    const resumed = await launch(run.profile)
    try {
      const user = await resumed.page.evaluate(() => window.panda.user.get())
      expect(user.favorites).toContain('db-35267208')
      const entry = user.history.find(entry => entry.id === 'db-35267208')!
      expect(entry.position).toBeGreaterThan(500)
      expect(entry.duration).toBeGreaterThan(3600)
      evidence.persisted = entry
      await resumed.page.evaluate(() => { location.hash = '#/me/history' })
      await expect(resumed.page.locator('.card__title')).toHaveText('流浪地球2')
      await capture(resumed.page, 'movie-persistence', evidence)
      expect(resumed.errors).toEqual([])
    } finally { await resumed.app.close() }
    expect(run.errors).toEqual([])
  } finally { if (!didClose) await app.close() }
})

test('real serial exposes playable episodes and decodes after switching to the next episode', async () => {
  const { app, page, errors, logs } = await launch()
  const evidence: Record<string, unknown> = { at: new Date().toISOString() }
  try {
    await page.evaluate(() => window.panda.user.dispatch({ type: 'settings', patch: { muted: true } }))
    await page.evaluate(() => { location.hash = '#/detail/db-26647087' })
    await expect(page.locator('.detail__title')).toHaveText('三体')
    await expect.poll(() => page.locator('.eps a').count(), { timeout: 30000 }).toBeGreaterThan(1)
    evidence.episodes = await page.evaluate(() => window.panda.data.availability('db-26647087'))
    await page.locator('.eps a').first().click()
    await playing(page)
    evidence.first = await videoStatus(page)
    await page.mouse.move(700, 840)
    await page.getByRole('button', { name: '选集', exact: true }).click()
    await expect(page.locator('.player__panel')).toHaveAttribute('data-open', '')
    await page.locator('.player__panel a').nth(1).click()
    await expect(page).toHaveURL(/#\/play\/db-26647087\/2$/)
    await playing(page)
    evidence.second = await videoStatus(page)
    await page.mouse.move(700, 840)
    await page.getByRole('button', { name: '下一集', exact: true }).click()
    await expect(page).toHaveURL(/#\/play\/db-26647087\/3$/)
    await playing(page)
    evidence.third = await videoStatus(page)
    evidence.filterDiagnostics = logs.filter(value => value.includes('[media]'))
    await capture(page, 'serial-playback', evidence)
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('real animation resolves by Douban identity and decodes its actual stream', async () => {
  const { app, page, errors, logs } = await launch()
  try {
    await page.evaluate(() => window.panda.user.dispatch({ type: 'settings', patch: { muted: true } }))
    // The bare title is the 2025 live-action series; the animation is listed under its subtitle.
    const item = await page.evaluate(async () => (await window.panda.data.search('凡人修仙传')).find(item => item.title.startsWith('凡人修仙传') && item.type === 'anime'))
    expect(item?.type).toBe('anime')
    await page.evaluate(id => { location.hash = '#/play/' + id + '/1' }, item!.id)
    await playing(page)
    await capture(page, 'animation-playback', { id: item!.id, title: item!.title, ...await videoStatus(page), filterDiagnostics: logs.filter(value => value.includes('[media]')) })
    expect(errors).toEqual([])
  } finally { await app.close() }
})
