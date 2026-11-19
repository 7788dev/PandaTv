import { test, expect, _electron, type Page } from '@playwright/test'
import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, evidenceDir, launch } from './desktop'

test('startup: a reload during initial loading does not report application failure', async () => {
  const profile = await mkdtemp(join(root, '.tmp', 'startup-'))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  env.PANDA_USER_DATA_DIR = profile
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['-r', join(root, 'e2e/startup-hook.cjs'), root], cwd: root, env })
  let result: unknown
  try {
    const page = await app.firstWindow()
    await page.waitForURL(/\/out\/renderer\/index\.html/, { waitUntil: 'commit' })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
    await expect(page.locator('.topbar')).toBeVisible()
    const failure = await readFile(join(profile, 'startup-error.json'), 'utf8').catch(() => null)
    expect(failure).toBeNull()
    await expect(page.locator('.hero__title')).toBeVisible()
    result = { at: new Date().toISOString(), reload: true, bridge: await page.evaluate(() => Boolean(window.panda)), failure }
  } finally {
    const failure = await readFile(join(profile, 'startup-error.json'), 'utf8').catch(() => null)
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(join(evidenceDir, `startup-reload-${process.env.PANDA_STARTUP_ROUND || 'after'}.json`), JSON.stringify(result ?? { failure: failure && JSON.parse(failure) }, null, 2))
    await app.close().catch(() => {})
  }
})

/** Milliseconds from the start of navigation until the home page has its data and its visible artwork. */
async function homeTimeline(page: Page) {
  return page.evaluate(() => new Promise<{ data?: number; images?: number; imageCount?: number; failed?: boolean }>(resolve => {
    const out: { data?: number; images?: number; imageCount?: number; failed?: boolean } = {}
    const tick = () => {
      const now = performance.now()
      const main = document.querySelector('main')
      if (main && main.getAttribute('aria-busy') !== 'true' && out.data === undefined) { out.data = Math.round(now); out.failed = !document.querySelector('.hero__title') }
      if (out.data !== undefined) {
        const visible = [...document.querySelectorAll<HTMLImageElement>('img.img')].filter(img => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth })
        if (visible.length && visible.every(img => img.complete && img.naturalWidth > 0)) { out.images = Math.round(now); out.imageCount = visible.length; return resolve(out) }
      }
      if (now > 30000) return resolve(out)
      setTimeout(tick, 16)
    }
    tick()
  }))
}

test('startup: a second start shows the home page and its artwork from what the first start saved', async () => {
  const first = await launch()
  const cold = await homeTimeline(first.page)
  expect(cold.failed).toBe(false)
  expect(cold.imageCount).toBeGreaterThan(5)
  // A first start shows the top of the page, then the shelves below it; the page is kept once it is whole.
  await expect(first.page.locator('main .section')).toHaveCount(6, { timeout: 30000 })
  const titles = await first.page.locator('.section a[href^="#/detail/"]').count()
  await expect.poll(() => readFile(join(first.profile, 'cache', 'home-v1.json'), 'utf8').then(() => true, () => false)).toBe(true)
  await first.app.close()
  expect(JSON.parse(await readFile(join(first.profile, 'cache', 'home-v1.json'), 'utf8')).version).toBe(1)
  const kept = (await readdir(join(first.profile, 'images'))).length
  expect(kept).toBeGreaterThanOrEqual(cold.imageCount!)

  const second = await launch(first.profile)
  const warm = await homeTimeline(second.page)
  const result = { at: new Date().toISOString(), executable: process.env.PANDA_E2E_EXECUTABLE ?? 'out/', unit: 'ms after navigation start', firstStart: cold, secondStart: warm, imagesKept: kept }
  await writeFile(join(evidenceDir, 'startup-second.json'), JSON.stringify(result, null, 2))
  expect(warm.failed).toBe(false)
  await expect(second.page.locator('main .section')).toHaveCount(6)
  expect(await second.page.locator('.section a[href^="#/detail/"]').count()).toBe(titles)
  // Ten Douban answers take about two seconds and the posters as long again; a start that waited
  // for either cannot be this quick. Measured 2026-11-16: data after 0.3 s, artwork after 0.45 s.
  expect(warm.data).toBeLessThan(1500)
  expect(warm.images).toBeLessThan(2500)
  expect(second.errors).toEqual([])
  await second.app.close()
})

test('startup: restores a maximized window after a clean restart', async () => {
  const first = await launch()
  try {
    await first.page.evaluate(() => window.panda.window.maximize())
    await expect.poll(() => first.page.evaluate(() => window.panda.window.getState())).toEqual({ maximized: true, fullscreen: false })
    await first.app.close()

    const second = await launch(first.profile)
    try {
      await expect.poll(() => second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true)
    } finally {
      await second.app.close()
    }
  } finally {
    await first.app.close().catch(() => {})
  }
})
