import { test, expect } from '@playwright/test'
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
})
