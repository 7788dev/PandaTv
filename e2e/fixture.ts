import { _electron, type Page } from '@playwright/test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { root } from './desktop'

export async function launchFixture(options: { pageSize?: number } = {}) {
  await mkdir(join(root, '.tmp'), { recursive: true })
  const profile = await mkdtemp(join(root, '.tmp', 'ui-fixture-'))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  env.PANDA_USER_DATA_DIR = profile
  if (options.pageSize) env.PANDA_FIXTURE_PAGE_SIZE = String(options.pageSize)
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: [join(root, 'e2e/fixture-main.cjs')], cwd: root, env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 901 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const mode = (value: string) => app.evaluate((_electron, value) => (globalThis as any).__fixture.setMode(value), value)
  const user = (value: unknown) => app.evaluate((_electron, value) => (globalThis as any).__fixture.setUser(value), value)
  return { app, page, errors, mode, user }
}

export async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => [...document.images].every(image => {
    const box = image.getBoundingClientRect()
    return box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth || image.complete
  }))
  await page.waitForTimeout(350)
}
