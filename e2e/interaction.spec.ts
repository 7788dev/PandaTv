import { expect, test } from '@playwright/test'
import { launchFixture, captureFixture } from './fixture'
import { playing } from './desktop'

test('fixture: search starts reverse navigation at the last option and Escape retains keyboard focus', async () => {
  const { app, page, errors } = await launchFixture()
  try {
    await expect(page.locator('.hero__title')).toBeVisible()
    await page.keyboard.press('Control+k')
    const field = page.getByRole('combobox')
    const options = page.locator('.hotlist__item')
    await expect(options).toHaveCount(10)
    await page.keyboard.press('ArrowUp')
    await expect(options.last()).toHaveAttribute('data-highlighted', '')
    await page.keyboard.press('Escape')
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('aria-expanded', 'false')
    await expect(field).not.toHaveAttribute('aria-activedescendant')
    await page.keyboard.press('ArrowDown')
    await expect(field).toHaveAttribute('aria-expanded', 'true')
    await expect(options.last()).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(options.first()).toHaveAttribute('data-highlighted', '')
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('fixture: episode panel owns focus and shortcuts and returns focus on every close', async () => {
  const { app, page, errors, user } = await launchFixture()
  try {
    await user({ history: [] })
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/2' })
    await playing(page)
    await page.keyboard.press('k')
    const trigger = page.getByRole('button', { name: '选集', exact: true })
    const drawer = page.locator('.player__panel[data-open]')
    for (let count = 0; count < 3; count++) {
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(drawer).toBeVisible()
      await expect(drawer.locator('[data-current]')).toBeFocused()
      const tabbable = await drawer.locator('button, a[href]').count()
      for (let step = 0; step <= tabbable; step++) {
        await page.keyboard.press('Tab')
        await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
      }
      const before = await page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBe(before)
      if (count === 0) await captureFixture(page, 'episode-dialog')
      await page.keyboard.press('Escape')
      await expect(drawer).not.toBeVisible()
      await expect(trigger).toBeFocused()
    }
    expect(errors).toEqual([])
  } finally { await app.close() }
})
