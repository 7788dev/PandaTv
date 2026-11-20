import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evidenceRoot, capture, playing } from './desktop'
import { launchFixture, settled } from './fixture'

test('fixture: loading, empty, error and offline surfaces remain usable', async () => {
  const run = await launchFixture()
  const { app, page, mode } = run
  try {
    await expect(page.locator('.hero__title')).toHaveText('雾港来信')
    for (const value of ['loading', 'empty', 'error', 'offline']) {
      await mode(value)
      await page.evaluate(() => { location.hash = '#/me' })
      await page.evaluate(() => { location.hash = '#/channel/tv' })
      if (value === 'loading') await expect(page.locator('[aria-busy=true]')).toBeVisible()
      else await expect(page.locator('.empty__text')).toContainText(value === 'empty' ? '暂无内容' : value === 'offline' ? '网络未连接' : '加载失败')
      await capture(page, 'state-' + value)
      if (value === 'error' || value === 'offline') {
        await mode('normal')
        await page.getByRole('button', { name: '重试', exact: true }).click()
        await expect(page.locator('.card').first()).toBeVisible()
      }
    }
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: search keyboard, tabs, favorites, history undo, settings and dialog focus', async () => {
  const run = await launchFixture()
  const { app, page, user } = run
  try {
    await expect(page.locator('.hero__title')).toBeVisible()
    await page.locator('.topbar__actions a[href="#/settings"]').hover()
    await expect(page.locator('.tooltip')).toHaveText('设置')
    await page.mouse.move(700, 500)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('combobox')).toBeFocused()
    await expect(page.locator('.hotlist__item')).toHaveCount(10)
    await page.getByRole('combobox').fill('长夜')
    await expect(page.locator('.suggest__item')).toHaveCount(1)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.detail__title')).toHaveText('长夜将明')
    await page.getByRole('button', { name: '已收藏', exact: true }).click()
    await expect(page.getByRole('button', { name: '收藏', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '收藏', exact: true }).click()
    await page.evaluate(() => { location.hash = '#/me/history' })
    await expect(page.locator('.card__remove').first()).toBeVisible()
    const count = await page.locator('.card').count()
    await page.locator('.card').first().hover()
    await page.locator('.card__remove').first().click()
    await expect(page.locator('.card')).toHaveCount(count - 1)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('.card')).toHaveCount(count)
    await page.evaluate(() => { location.hash = '#/settings' })
    const toggle = page.getByRole('switch', { name: '自动播放下一集' })
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await page.getByRole('button', { name: '默认倍速' }).click()
    await page.getByRole('menuitemradio', { name: '1.5×', exact: true }).click()
    await page.locator('.setrow').filter({ hasText: '清空观看历史' }).getByRole('button').click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).not.toBeVisible()
    await page.getByRole('button', { name: '检查更新' }).click()
    await expect(page.locator('.toast:not([data-ending-style]):not([data-limited])')).toContainText('更新服务未配置')
    await user({ favorites: [], history: [] })
    await page.evaluate(() => { location.hash = '#/me' })
    await expect(page.locator('.empty__text')).toHaveText('还没有收藏')
    await page.getByRole('tab', { name: '历史', exact: true }).click()
    await expect(page.locator('.empty__text')).toHaveText('还没有观看记录')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: player quality, volume, episode panel, intro, up-next and retry controls', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { skipIntro: false, autoNext: true, muted: true } })
    await mode('intro')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/1' })
    await playing(page)
    await expect(page.locator('.player__skip')).toHaveAttribute('data-open', '')
    await page.locator('.player__skip').click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThanOrEqual(90)
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '清晰度', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '480P', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.videoWidth)).toBe(640)
    await page.getByRole('button', { name: '取消静音', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.muted)).toBe(false)
    // Unmuting reports the restored level, as the design's mute() does.
    await expect(page.locator('.osd')).toHaveAttribute('data-open', '')
    await expect(page.locator('.osd')).toContainText('%')
    await page.getByRole('slider', { name: '音量', exact: true }).focus()
    await page.keyboard.press('Home')
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.volume)).toBe(0)
    await page.keyboard.press('End')
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.volume)).toBe(1)
    // Arrow keys on the volume slider move it by the design step (5%), never seek.
    const before = await page.evaluate(() => document.querySelector('video')!.currentTime)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('video')!.volume * 100))).toBe(95)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('video')!.volume * 100))).toBe(90)
    await expect(page.locator('.osd')).toContainText('90%')
    expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThanOrEqual(before)
    await page.keyboard.press('m')
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.muted)).toBe(true)
    await expect(page.locator('.osd')).toContainText('静音')
    await page.evaluate(() => { document.querySelector('video')!.muted = true })
    await page.getByRole('button', { name: '选集', exact: true }).click()
    await expect(page.locator('.player__panel')).toHaveAttribute('data-open', '')
    await page.keyboard.press('Escape')
    await expect(page.locator('.player__panel')).not.toHaveAttribute('data-open', '')
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 112 })
    await expect(page.locator('.upnext')).toHaveAttribute('data-open', '')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.upnext')).not.toHaveAttribute('data-open', '')
    await mode('player-error')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await expect(page.locator('.player')).toHaveAttribute('data-error', '')
    await mode('normal')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await playing(page)
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: window controls remain usable while a confirmation is open', async () => {
  const { app, page } = await launchFixture()
  let closed = false
  try {
    await page.evaluate(() => { location.hash = '#/settings' })
    await page.locator('.setrow').filter({ hasText: '清空观看历史' }).getByRole('button').click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: '最大化', exact: true }).click({ timeout: 5000 })
    await expect.poll(() => page.evaluate(() => window.panda.window.getState())).toEqual({ maximized: true, fullscreen: false })
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: '还原', exact: true }).click()
    await page.getByRole('button', { name: '最小化', exact: true }).click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
    const ended = app.waitForEvent('close')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await ended
    closed = true
  } finally { if (!closed) await app.close() }
})

test('fixture: a source that never starts recovers within thirty-five seconds', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [] })
    await mode('source-hang')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/1' })
    await expect.poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0), { timeout: 35000 }).toBeGreaterThan(1)
    await capture(page, 'source-recovery')
  } finally { await app.close() }
})

test('fixture: another line takes over where the first one was', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/1' })
    await playing(page)
    // One source: nothing to choose from, so no control for it.
    await expect(page.getByRole('button', { name: '线路', exact: true })).toHaveCount(0)
    await mode('lines')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 40 })
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: '线路一', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentSrc)).toContain('line=second')
    await playing(page)
    expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThanOrEqual(40)
    await page.mouse.move(700, 851)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: '线路二', exact: true })).toHaveAttribute('aria-checked', 'true')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: sustained decoder drops lower playback speed automatically', async () => {
  const run = await launchFixture()
  const { app, page, user } = run
  try {
    await page.evaluate(() => {
      let startedAt = 0
      Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', {
        configurable: true,
        value() {
          startedAt ||= Date.now()
          const elapsed = Math.max(0, Date.now() - startedAt)
          return { totalVideoFrames: Math.floor(elapsed / 33), droppedVideoFrames: Math.floor(elapsed / 100), corruptedVideoFrames: 0 }
        },
      })
    })
    await user({ history: [], settings: { muted: true, speed: 2 } })
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.playbackRate), { timeout: 18000 }).toBe(1.5)
    await expect(page.getByRole('heading', { name: '已降至 1.5×，减少掉帧' })).toBeVisible()
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: a failed line switch falls back to the source pool without losing position', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await mode('line-switch-error')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 38 })
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    const position = await page.evaluate(() => document.querySelector('video')!.currentTime)
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentSrc)).toContain('pool=retry')
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(position + 1)
    await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
    await expect(page.locator('.player')).not.toHaveAttribute('data-waiting', '')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: changing lines while paused keeps playback paused', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await mode('lines')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 38 })
    await page.waitForFunction(() => !document.querySelector('video')!.seeking)
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    await page.waitForFunction(() => {
      const v = document.querySelector('video')!
      return v.currentSrc.includes('line=second') && v.readyState >= 3 && !v.seeking
    })
    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
    expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThanOrEqual(37)
    await expect(page.locator('.player__handoff')).not.toHaveAttribute('data-visible', '')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: failed replacements preserve a paused line and its controls', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await mode('line-switch-error-all')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const oldSource = await page.evaluate(() => document.querySelector('video')!.currentSrc)
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    await page.waitForTimeout(5000)
    expect(await page.evaluate(() => document.querySelector('video')!.currentSrc)).toBe(oldSource)
    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
    await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
    await expect(page.getByRole('button', { name: '播放', exact: true }).last()).toBeEnabled()
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: if both the selected line and source pool fail, the current picture keeps playing', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await mode('line-switch-error-all')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 38 })
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    await expect(page.getByRole('heading', { name: '切换未成功，保留当前线路' }).first()).toBeVisible({ timeout: 20000 })
    const position = await page.evaluate(() => document.querySelector('video')!.currentTime)
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(position + 1)
    await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
    await expect(page.locator('.player')).not.toHaveAttribute('data-waiting', '')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: a stalled replacement line keeps the last decoded frame visible', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await mode('line-switch-stall')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 42 })
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentSrc)).toContain('line=second')
    await expect(page.locator('.player__handoff[data-visible]')).toBeVisible()
    await expect.poll(() => page.locator('.player__handoff').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: a stalled manual line falls back to the active source pool', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ history: [], settings: { muted: true } })
    await mode('line-switch-stall')
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 42 })
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '线路', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '线路二', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentSrc)).toContain('line=second')
    await expect(page.locator('.player__handoff[data-visible]')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 30000 }).toBeGreaterThan(42)
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentSrc)).not.toContain('stall.mp4')
    await expect(page.locator('.player__handoff')).not.toHaveAttribute('data-visible', '')
    await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: prototype and production share page geometry and visual tokens', async () => {
  const run = await launchFixture()
  const { app, page } = run
  try {
    const opened = app.waitForEvent('window')
    await app.evaluate(async () => { await (globalThis as any).__fixture.prototype() })
    const reference = await opened
    await reference.setViewportSize({ width: 1440, height: 901 })
    const visual = join(evidenceRoot, 'visual')
    await mkdir(visual, { recursive: true })
    const scenarios = [
      { name: '01-home', route: '#/', selector: '.hero__title' },
      { name: '03-channel', route: '#/channel/tv', selector: '.filters' },
      { name: '04-detail', route: '#/detail/changye-jiangming', selector: '.detail__title' },
      { name: '08-search-results', route: '#/search?q=长夜', selector: '.feature__title' },
      { name: '09-empty', route: '#/search?q=不存在的电影', selector: '.empty__text' },
      { name: '10-me-favorites', route: '#/me', selector: '.grid .card' },
      { name: '11-me-history', route: '#/me/history', selector: '.group__label' },
      { name: '12-settings', route: '#/settings', selector: '.about' },
    ]
    for (const scenario of scenarios) {
      await page.evaluate(route => { location.hash = route }, scenario.route)
      await reference.evaluate(route => { location.hash = route }, scenario.route)
      await expect(page.locator(scenario.selector).first()).toBeVisible()
      await expect(reference.locator(scenario.selector).first()).toBeVisible()
      await settled(page); await settled(reference)
      await page.screenshot({ path: join(visual, scenario.name + '-production.png') })
      await reference.screenshot({ path: join(visual, scenario.name + '-prototype.png') })
      const selector = scenario.name === '01-home' ? '.hero__body' : scenario.name === '04-detail' ? '.detail__head' : '.page__head'
      const measured = await Promise.all([page, reference].map(view => view.locator(selector).boundingBox()))
      expect(Math.abs(measured[0]!.x - measured[1]!.x)).toBeLessThan(1)
      expect(Math.abs(measured[0]!.y - measured[1]!.y)).toBeLessThan(1)
    }
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})

/** Share of pixels whose colour differs by more than 24/255 in any channel, measured in the main process. */
async function pixelDifference(app: ElectronApplication, a: string, b: string) {
  return app.evaluate(({ nativeImage }, [a, b]) => {
    const [x, y] = [nativeImage.createFromPath(a!), nativeImage.createFromPath(b!)]
    const size = x.getSize(), other = y.getSize()
    if (size.width !== other.width || size.height !== other.height) return 1
    const p = x.toBitmap(), q = y.toBitmap()
    let differing = 0
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i]! - q[i]!) > 24 || Math.abs(p[i + 1]! - q[i + 1]!) > 24 || Math.abs(p[i + 2]! - q[i + 2]!) > 24) differing++
    return differing / (size.width * size.height)
  }, [a, b])
}

test('fixture: overlays, episode lists and player chrome sit where the prototype puts them', async () => {
  const run = await launchFixture()
  const { app, page, mode, user } = run
  try {
    await user({ settings: { skipIntro: false, autoNext: true, muted: true } })
    const opened = app.waitForEvent('window')
    await app.evaluate(async () => { await (globalThis as any).__fixture.prototype() })
    const reference = await opened
    await reference.setViewportSize({ width: 1440, height: 901 })
    const views = [page, reference]
    const dir = join(evidenceRoot, 'visual')
    await mkdir(dir, { recursive: true })
    const report: Array<{ name: string; boxes: Record<string, { production: unknown; prototype: unknown }>; pixelDifference: number }> = []
    const go = async (route: string, referenceRoute = route) => {
      await page.evaluate(route => { location.hash = route }, route)
      await reference.evaluate(route => { location.hash = route }, referenceRoute)
    }
    /** Compares where both windows put the same elements and records the pair of screenshots. */
    const compare = async (name: string, selectors: string[], pixels?: number) => {
      const boxes: Record<string, { production: unknown; prototype: unknown }> = {}
      for (const selector of selectors) {
        for (const view of views) await expect(view.locator(selector).first(), `${name} ${selector}`).toBeVisible()
        await expect.poll(async () => {
          const [production, prototype] = await Promise.all(views.map(view => view.locator(selector).first().boundingBox()))
          boxes[selector] = { production, prototype }
          return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(production![key] - prototype![key])))
        }, { message: `${name} ${selector}`, timeout: 6000 }).toBeLessThan(1)
      }
      for (const view of views) await settled(view)
      const files = ['production', 'prototype'].map(kind => join(dir, `${name}-${kind}.png`))
      await page.screenshot({ path: files[0] }); await reference.screenshot({ path: files[1] })
      const pixelShare = await pixelDifference(app, files[0]!, files[1]!)
      report.push({ name, boxes, pixelDifference: Number(pixelShare.toFixed(5)) })
      if (pixels !== undefined) expect(pixelShare, `${name} pixel difference`).toBeLessThan(pixels)
    }

    // 02: lower shelves of the home page.
    await go('#/')
    for (const view of views) { await expect(view.locator('.hero__title')).toBeVisible(); await view.evaluate(() => { document.querySelector('.scroll--page .scroll__viewport')!.scrollTop = 900 }) }
    await compare('02-home-shelves', ['.shelf >> nth=1', '.shelf >> nth=2'])

    // 05: titled episode list and segmented episode grid.
    await go('#/detail/xiangshan-erxing')
    await compare('05-detail-episode-list', ['.detail__head', '.eplist', '.eplist__item >> nth=3'], 0.01)
    await go('#/detail/jixie-zhixin')
    await compare('05-detail-episode-ranges', ['.detail__head', '.eps', '.ep >> nth=49'], 0.01)

    // 06/07: search panel with recent + hot searches, then suggestions.
    await go('#/')
    for (const view of views) { await expect(view.locator('.hero__title')).toBeVisible(); await view.locator('.search .field__input').click() }
    await compare('06-search-panel', ['.search', '.search__panel', '.hotlist__item >> nth=9'])
    for (const view of views) await view.locator('.search .field__input').fill('长夜')
    await compare('07-search-suggest', ['.search__panel', '.suggest__item'])
    for (const view of views) await view.keyboard.press('Escape')

    // 13/14: settings menu and confirmation dialog.
    await go('#/settings')
    for (const view of views) { await expect(view.locator('.about')).toBeVisible(); await view.locator('.setrow .select').first().click() }
    await compare('13-menu', ['.menu', '.menu__item >> nth=0', '.menu__item >> nth=3'], 0.01)
    for (const view of views) await view.keyboard.press('Escape')
    for (const view of views) { await expect(view.locator('.menu')).toHaveCount(0); await view.locator('.setgroup >> nth=1').locator('.btn').first().click() }
    await compare('14-dialog', ['.dialog', '.dialog__title', '.dialog__actions .btn >> nth=0', '.dialog__actions .btn >> nth=1'], 0.01)
    for (const view of views) await view.keyboard.press('Escape')
    for (const view of views) await expect(view.locator('.dialog')).toHaveCount(0)

    // 15–19: the prototype forces player states with a debug parameter; production reaches them for real.
    const chrome = ['.player__top', '.player__title', '.player__bottom', '.seek', '.player__bar', '.player__play', '.player__time', '.player__volume']
    await user({ history: [] })
    await go('#/play/changye-jiangming/1', '#/play/changye-jiangming/1?state=paused')
    await playing(page)
    await page.keyboard.press('Space')
    await expect(page.locator('.player')).toHaveAttribute('data-paused', '')
    await compare('15-player-paused', [...chrome, '.player__bigplay'])
    await go('#/play/changye-jiangming/1', '#/play/changye-jiangming/1?state=panel')
    await page.mouse.move(700, 850)
    await page.getByRole('button', { name: '选集', exact: true }).click()
    await compare('16-player-episodes', ['.player__panel', '.player__panel-head', '.player__panel-body .ep >> nth=0', '.player__panel-body .ep >> nth=17'])
    await page.keyboard.press('Escape')
    await go('#/play/changye-jiangming/1', '#/play/changye-jiangming/1?state=upnext')
    await page.evaluate(() => { const video = document.querySelector('video')!; void video.play(); video.currentTime = video.duration - 8 })
    await expect(page.locator('.upnext')).toHaveAttribute('data-open', '')
    await compare('17-player-up-next', ['.upnext', '.upnext__title', '.upnext__actions'])
    await mode('player-error')
    await go('#/play/changye-jiangming/3', '#/play/changye-jiangming/3?state=error')
    await expect(page.locator('.player')).toHaveAttribute('data-error', '')
    // What lies under the message is not comparable: the prototype dims a frame of its demo clip
    // (when the network has delivered it), production has no picture because it has no source.
    for (const view of views) await view.evaluate(() => { document.querySelector<HTMLVideoElement>('.player__video')!.style.visibility = 'hidden' })
    await compare('19-player-error', ['.player__error', '.player__error .empty__text', '.player__error .btn', '.player__top'], 0.01)
    for (const view of views) await view.evaluate(() => { document.querySelector<HTMLVideoElement>('.player__video')!.style.visibility = '' })
    await mode('normal')

    await writeFile(join(dir, 'overlay-report.json'), JSON.stringify({ at: new Date().toISOString(), viewport: '1440x901', tolerance: 'every listed box within 1 CSS px on x, y, width and height', scenes: report }, null, 1) + '\n')
    expect(run.errors).toEqual([])
  } finally { await app.close() }
})
