import { test, expect } from '@playwright/test'
import { playing } from './desktop'
import { launchFixture, settled } from './fixture'

const viewports = [
  { name: 'compact', width: 1080, height: 640 },
  { name: 'standard', width: 1440, height: 901 },
  { name: 'wide', width: 2560, height: 1440 },
]
const channels = ['tv', 'movie', 'variety', 'anime', 'doc']

test.describe('desktop layout geometry', () => {
  for (const viewport of viewports) {
    test(`channel filters stay clear of the first row at ${viewport.name} size`, async () => {
      const run = await launchFixture({ pageSize: 2 })
      const { app, page } = run
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        for (const channel of channels) {
          await page.evaluate(channel => { location.hash = `#/channel/${channel}` }, channel)
          await expect(page.locator('.filters')).toBeVisible()
          await expect(page.locator('.grid .card').first()).toBeVisible()

          // Expand every filter row before loading more pages, matching the long-lived state
          // that used to make controls cover the first movie row on the way back up.
          await page.locator('.filters__expand').evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).click()))
          await expect(page.locator('.filters__expand[aria-expanded="true"]')).toHaveCount(await page.locator('.filters__expand').count())

          const viewportEl = page.locator('.scroll__viewport')
          await viewportEl.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect.poll(() => page.locator('.grid .card').count()).toBeGreaterThan(2)
          await page.waitForTimeout(150)
          await viewportEl.evaluate(element => { element.scrollTop = 0 })
          await settled(page)

          const geometry = await page.evaluate(() => {
            const filters = document.querySelector<HTMLElement>('.filters')!.getBoundingClientRect()
            const first = document.querySelector<HTMLElement>('.grid .card')!.getBoundingClientRect()
            const viewport = document.querySelector<HTMLElement>('.scroll__viewport')!.getBoundingClientRect()
            const visible = [...document.querySelectorAll<HTMLElement>('.grid .card')].filter(card => {
              const box = card.getBoundingClientRect()
              return box.bottom > viewport.top && box.top < viewport.bottom
            }).length
            return { filters, first, viewport, visible, scrollHeight: document.querySelector<HTMLElement>('.scroll__viewport')!.scrollHeight }
          })

          expect(geometry.first.top).toBeGreaterThanOrEqual(geometry.filters.bottom - 1)
          expect(geometry.first.top).toBeGreaterThan(geometry.viewport.top)
          expect(geometry.visible).toBeGreaterThan(0)
        }
        expect(run.errors).toEqual([])
      } finally { await app.close() }
    })
  }

  test('primary pages and overlays remain within the desktop viewport', async () => {
    const run = await launchFixture()
    const { app, page } = run
    const consoleErrors: string[] = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    try {
      const assertNoOverflow = async (label: string) => {
        const overflow = await page.evaluate(() => {
          const width = innerWidth, height = innerHeight
          return [...document.querySelectorAll<HTMLElement>('main, .page__head, .filters, .grid, .section, .setgroup, .dialog, .search__panel, .menu')]
            .filter(element => element.getClientRects().length > 0)
            .filter(element => {
              const box = element.getBoundingClientRect()
              return box.width > width + 1 || box.left < -1 || box.right > width + 1 || (element.matches('.dialog, .search__panel, .menu') && (box.top < -1 || box.bottom > height + 1))
            })
            .map(element => ({ className: element.className, box: element.getBoundingClientRect().toJSON() }))
        })
        expect(overflow, label).toEqual([])
        const deadLinks = await page.locator('a:visible').evaluateAll(links => links
          .map(link => ({ text: link.textContent?.trim(), href: (link as HTMLAnchorElement).getAttribute('href') }))
          .filter(link => !link.href || link.href === '#'))
        expect(deadLinks, `${label} has no inert links`).toEqual([])
      }
      for (const size of [{ width: 1080, height: 640 }, { width: 1440, height: 901 }]) {
        await page.setViewportSize(size)
        for (const route of ['#/', '#/channel/movie', '#/detail/changye-jiangming', '#/me', '#/settings']) {
          await page.evaluate(route => { location.hash = route }, route)
          await settled(page)
          await assertNoOverflow(`${route} at ${size.width}x${size.height}`)
        }

        await page.evaluate(() => { location.hash = '#/' })
        await page.locator('.search .field__input').click()
        await expect(page.locator('.search__panel')).toBeVisible()
        await assertNoOverflow(`search panel at ${size.width}x${size.height}`)
        await page.keyboard.press('Escape')

        await page.evaluate(() => { location.hash = '#/settings' })
        await page.locator('.setrow .select').first().click()
        await expect(page.locator('.menu')).toBeVisible()
        await assertNoOverflow(`settings menu at ${size.width}x${size.height}`)
        await page.keyboard.press('Escape')
        await page.locator('.setrow').filter({ hasText: '清空观看历史' }).getByRole('button').click()
        await expect(page.locator('.dialog')).toBeVisible()
        await assertNoOverflow(`confirmation dialog at ${size.width}x${size.height}`)
        await page.keyboard.press('Escape')
      }
      expect(run.errors).toEqual([])
      expect(consoleErrors).toEqual([])
    } finally { await app.close() }
  })

  test('compact home keeps featured copy clear of the thumbnails and inside the hero', async () => {
    const run = await launchFixture()
    const { app, page } = run
    try {
      await page.setViewportSize({ width: 1080, height: 640 })
      await page.evaluate(() => { location.hash = '#/' })
      await expect(page.locator('.hero__title')).toHaveText('雾港来信')
      await settled(page)
      const geometry = await page.evaluate(() => {
        const hero = document.querySelector<HTMLElement>('.hero')!.getBoundingClientRect()
        const body = document.querySelector<HTMLElement>('.hero__body')!.getBoundingClientRect()
        const pager = document.querySelector<HTMLElement>('.hero__pager')!.getBoundingClientRect()
        const title = document.querySelector<HTMLElement>('.hero__title')!.getBoundingClientRect()
        return { heroTop: hero.top, heroBottom: hero.bottom, bodyTop: body.top, bodyRight: body.right, pagerLeft: pager.left, titleBottom: title.bottom }
      })
      expect(geometry.bodyRight).toBeLessThanOrEqual(geometry.pagerLeft - 8)
      expect(geometry.bodyTop).toBeGreaterThanOrEqual(geometry.heroTop)
      expect(geometry.titleBottom).toBeLessThanOrEqual(geometry.heroBottom)
      expect(run.errors).toEqual([])
    } finally { await app.close() }
  })

  test('compact detail keeps its information and first episode row in view', async () => {
    const run = await launchFixture()
    const { app, page } = run
    try {
      await page.setViewportSize({ width: 1080, height: 640 })
      await page.evaluate(() => { location.hash = '#/detail/changye-jiangming' })
      await expect(page.locator('.detail__title')).toHaveText('长夜将明')
      await expect(page.locator('.detail__head + .section .section__title')).toBeVisible()
      await settled(page)
      const geometry = await page.evaluate(() => {
        const head = document.querySelector<HTMLElement>('.detail__head')!.getBoundingClientRect()
        const poster = document.querySelector<HTMLElement>('.detail__poster')!.getBoundingClientRect()
        const section = document.querySelector<HTMLElement>('.detail__head + .section')!.getBoundingClientRect()
        return { headBottom: head.bottom, posterWidth: poster.width, sectionTop: section.top, height: innerHeight }
      })
      expect(geometry.posterWidth).toBeGreaterThanOrEqual(160)
      expect(geometry.headBottom).toBeLessThan(geometry.height)
      expect(geometry.sectionTop).toBeLessThan(geometry.height)
      expect(run.errors).toEqual([])
    } finally { await app.close() }
  })

  test('compact player bar keeps both control groups apart', async () => {
    const run = await launchFixture()
    const { app, page } = run
    try {
      await page.setViewportSize({ width: 1080, height: 640 })
      await page.evaluate(() => { location.hash = '#/play/changye-jiangming/1' })
      await playing(page)
      await page.mouse.move(540, 320)
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.player__bar')!.getBoundingClientRect()
        const [left, right] = [...document.querySelectorAll<HTMLElement>('.player__group')].map(group => group.getBoundingClientRect())
        return { barLeft: bar.left, barRight: bar.right, leftRight: left!.right, rightLeft: right!.left, rightRight: right!.right, width: innerWidth }
      })
      expect(geometry.leftRight).toBeLessThanOrEqual(geometry.rightLeft - 4)
      expect(geometry.barLeft).toBeGreaterThanOrEqual(0)
      expect(geometry.barRight).toBeLessThanOrEqual(geometry.width)
      expect(geometry.rightRight).toBeLessThanOrEqual(geometry.width)
      expect(run.errors).toEqual([])
    } finally { await app.close() }
  })

  test('returning to a page restores its scroll position', async () => {
    const run = await launchFixture()
    const { app, page } = run
    try {
      await page.setViewportSize({ width: 1080, height: 640 })
      await page.evaluate(() => { location.hash = '#/' })
      await expect(page.locator('.hero__title')).toHaveText('雾港来信')
      await settled(page)
      const viewport = page.locator('.scroll__viewport')
      const maximum = await viewport.evaluate(element => element.scrollHeight - element.clientHeight)
      const wanted = Math.min(600, maximum)
      expect(wanted).toBeGreaterThan(200)
      await viewport.evaluate((element, top) => { element.scrollTop = top }, wanted)
      await page.waitForTimeout(150)
      expect(await viewport.evaluate(element => element.scrollTop)).toBe(wanted)
      await page.evaluate(() => { location.hash = '#/detail/changye-jiangming' })
      await expect(page.locator('.detail__title')).toHaveText('长夜将明')
      await page.evaluate(() => history.back())
      await expect(page.locator('.hero__title')).toHaveText('雾港来信')
      await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(wanted)
      expect(run.errors).toEqual([])
    } finally { await app.close() }
  })
})