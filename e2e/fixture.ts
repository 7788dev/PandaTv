import { _electron, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evidenceRoot, root, temporaryProfile } from './desktop'

export async function captureFixture(page: Page, name: string) {
  const output = join(evidenceRoot, 'desktop-fixture')
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: join(output, `${name}-fixture.png`) })
}

export async function launchFixture(options: { pageSize?: number } = {}) {
  const profile = await temporaryProfile()
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  env.PANDA_USER_DATA_DIR = profile
  if (options.pageSize) env.PANDA_FIXTURE_PAGE_SIZE = String(options.pageSize)
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: [join(root, 'e2e/fixture-main.cjs')], cwd: root, env })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    app.on('window', extra => { if (extra !== page) errors.push(`Unexpected fixture window: ${extra.url()}`) })
    page.on('pageerror', error => errors.push(error.message))
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isVisible()))
    if (windows.length !== 1 || windows[0] || fileURLToPath(page.url()) !== join(root, 'out', 'renderer', 'index.html')) {
      throw new Error(`Expected one hidden fixture window with the compiled renderer, got ${page.url()} (${JSON.stringify(windows)})`)
    }
    await page.setViewportSize({ width: 1440, height: 901 })
    const mode = (value: string) => app.evaluate((_electron, value) => (globalThis as any).__fixture.setMode(value), value)
    const user = (value: unknown) => app.evaluate((_electron, value) => (globalThis as any).__fixture.setUser(value), value)
    return { app, page, errors, mode, user }
  } catch (error) {
    await app.close()
    throw error
  }
}

export async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => [...document.images].every(image => {
    const box = image.getBoundingClientRect()
    return box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth || image.complete
  }))
  await page.waitForTimeout(350)
}
