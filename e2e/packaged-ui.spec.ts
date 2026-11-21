import { expect, test } from '@playwright/test'
import { capture, launch, root } from './desktop'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('packaged live: real navigation, dialogs and hit targets at native window sizes', async () => {
  test.skip(!process.env.PANDA_E2E_EXECUTABLE, 'Requires a packaged Panda.exe via PANDA_E2E_EXECUTABLE')
  const { app, page, errors } = await launch()
  const consoleErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text()) })
  try {
    const identity = await app.evaluate(({ app, BrowserWindow }) => ({
      version: app.getVersion(), path: app.getAppPath(), windows: BrowserWindow.getAllWindows().length,
    }))
    expect(identity.windows).toBe(1)
    const asarSha256 = createHash('sha256').update(await readFile(identity.path)).digest('hex').toUpperCase()
    const bundledHtml = await readFile(join(root, 'out/renderer/index.html'), 'utf8')
    const rendererChunk = bundledHtml.match(/\.\/assets\/index-[\w-]+\.js/)?.[0]
    expect(rendererChunk, 'built renderer bundle').toBeTruthy()
    const script = await page.locator('script[type=module][src]').getAttribute('src')
    expect(script, 'this exact production bundle is loaded from app.asar').toBe(rendererChunk)

    const resize = async (width: number, height: number) => {
      const native = await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(size.width, size.height)
        return { viewport: window.getContentSize(), outer: window.getSize() }
      }, { width, height })
      expect(Math.abs(native.viewport[0]! - width), 'native content width').toBeLessThanOrEqual(3)
      expect(Math.abs(native.viewport[1]! - height), 'native content height').toBeLessThanOrEqual(3)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(native.viewport)
      return { requested: [width, height], ...native, devicePixelRatio: await page.evaluate(() => devicePixelRatio) }
    }
    const blocked = async (selector: string) => page.locator(selector).evaluateAll(elements => elements.length ? elements.flatMap(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit && element.contains(hit) ? [] : [{ name: element.getAttribute('aria-label') ?? element.textContent, hit: hit?.className, left: rect.left, right: rect.right }]
    }) : ['missing controls'])
    await expect(page.locator('.hero__title')).toBeVisible()
    await expect.poll(() => page.locator('.hero img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    const standard = await resize(1440, 900)
    await capture(page, 'home-packaged-live', { identity, asarSha256, title: await page.locator('.hero__title').innerText(), rendererChunk, standard })

    const compact = await resize(1080, 640)
    const search = page.getByRole('combobox')
    await page.keyboard.press('Control+k')
    await expect(search).toBeFocused()
    await search.fill('三体')
    await expect(page.locator('.suggest__item').first()).toBeVisible()
    await capture(page, 'search-compact-packaged-live', { identity, asarSha256, compact, blocked: await blocked('.topbar__actions .icon-btn, .winctl__btn') })
    await expect.poll(() => blocked('.topbar__actions .icon-btn, .winctl__btn')).toEqual([])
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.feature__title')).toHaveText('三体')
    await page.locator('.feature__title a').click()
    await expect(page.locator('.detail__title')).toHaveText('三体')
    await page.getByRole('button', { name: '收藏', exact: true }).click()
    await page.getByRole('link', { name: '我的', exact: true }).click()
    await expect(page.locator('.grid .card__title')).toContainText('三体')
    await page.getByRole('tab', { name: '历史', exact: true }).click()
    await expect(page.locator('.empty__text')).toHaveText('还没有观看记录')

    await page.getByRole('link', { name: '设置', exact: true }).click()
    const trigger = page.locator('.setrow').filter({ hasText: '清空观看历史' }).getByRole('button')
    await trigger.click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
    await expect.poll(() => blocked('.dialog__actions button, .winctl__btn')).toEqual([])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.getByRole('button', { name: '默认倍速', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: '2.0×' })).toBeVisible()
    await page.keyboard.press('Escape')
    await capture(page, 'settings-compact-packaged-live', { identity, asarSha256, compact })
    expect(errors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally { await app.close() }
})
