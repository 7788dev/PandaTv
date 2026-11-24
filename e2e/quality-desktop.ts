import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualityNetwork } from './quality-network'

export async function fixtureDesktop(label: string) {
  const dir = resolve('.tmp/quality-fixtures/runs', label + '-' + Date.now())
  mkdirSync(dir, { recursive: true })
  const network = await qualityNetwork()
  const sourceConfig = join(dir, 'sources.json')
  writeFileSync(sourceConfig, JSON.stringify({ version: 3, verifiedAt: '2026-11-24T00:00:00Z', maxDropRatio: .15, foreignBlockMaxSeconds: 45,
    sources: ['a', 'b', 'c'].map((key, i) => ({ key, name: `线路${['甲', '乙', '丙'][i]}`, api: `https://${key}.catalog.qa.example.org/api`, enabled: true, priority: 20 - i, adPaths: [], fingerprints: [] })) }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.PANDA_USER_DATA_DIR = join(dir, 'user-data')
  env.PANDA_SOURCE_CONFIG = sourceConfig
  env.PANDA_E2E_NETWORK_ORIGIN = network.origin
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RENDERER_URL
  const wrapper = join(dir, 'application')
  mkdirSync(wrapper)
  symlinkSync(resolve('resources'), join(wrapper, 'resources'), 'junction')
  writeFileSync(join(wrapper, 'package.json'), JSON.stringify({ name: 'panda-quality-fixture', version: '1.1.4', main: 'bootstrap.cjs' }))
  writeFileSync(join(wrapper, 'bootstrap.cjs'), `require(${JSON.stringify(resolve('e2e/network-boundary.cjs'))}); require(${JSON.stringify(resolve('out/main/index.js'))});`)
  let app: ElectronApplication
  const audioArgs = process.env.PANDA_E2E_SILENT_OUTPUT === '2' ? ['--disable-audio-output'] : process.env.PANDA_E2E_SILENT_OUTPUT === '1' ? ['--mute-audio'] : []
  const extraArgs = (process.env.PANDA_E2E_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)
  try { app = await _electron.launch({ args: [...extraArgs, ...audioArgs, wrapper], env, cwd: process.cwd(), timeout: 30000 }) }
  catch (error) { await network.close(); throw error }
  if (!await app.evaluate(() => process.env.PANDA_E2E_BOUNDARY_LOADED === 'true')) {
    await app.close(); await network.close(); throw new Error('The required network boundary was not loaded')
  }
  const page = await app.firstWindow()
  const errors: string[] = []
  const logs: Array<{ at: number; process: string; message: string }> = []
  app.on('console', message => logs.push({ at: Date.now(), process: 'main', message: message.text() }))
  page.on('console', message => logs.push({ at: Date.now(), process: 'renderer', message: message.text() }))
  page.on('pageerror', error => errors.push(String(error)))
  await page.evaluate(() => {
    const events: Array<Record<string, unknown>> = []
    ;(window as unknown as { qualityMediaEvents: typeof events }).qualityMediaEvents = events
    for (const name of ['loadedmetadata', 'loadeddata', 'playing', 'play', 'pause', 'waiting', 'stalled', 'error', 'emptied']) document.addEventListener(name, event => {
      const v = event.target
      if (v instanceof HTMLVideoElement) events.push({ at: Date.now(), name, paused: v.paused, time: v.currentTime, readyState: v.readyState, error: v.error?.message })
    }, true)
  })
  await page.locator('.topbar').waitFor()
  expect(fileURLToPath(page.url())).toBe(resolve('out/renderer/index.html'))
  writeFileSync(join(dir, 'runtime-identity.json'), JSON.stringify({
    ...await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), executable: app.getPath('exe'), versions: process.versions })),
    frontend: page.url(), main: resolve('out/main/index.js'), preload: resolve('out/preload/index.js'),
    resources: resolve('resources'), audioOutput: audioArgs.length ? audioArgs[0] : 'default',
    input: 'Controlled HTTP responses; production main, preload and renderer',
  }, null, 2))
  return { app, page, network, dir, errors, close: async () => {
    try {
      writeFileSync(join(dir, 'transport-calls.json'), JSON.stringify(network.calls, null, 2))
      writeFileSync(join(dir, 'page-errors.json'), JSON.stringify(errors, null, 2))
      writeFileSync(join(dir, 'runtime-logs.json'), JSON.stringify(logs, null, 2))
      const events = await page.evaluate(() => (window as unknown as { qualityMediaEvents?: unknown }).qualityMediaEvents ?? [])
      writeFileSync(join(dir, 'media-events.json'), JSON.stringify(events, null, 2))
    } finally {
      try { await app.close() } finally { await network.close() }
    }
  } }
}
export async function resize(app: ElectronApplication, width: number, height: number, zoom = 1) {
  await app.evaluate(({ BrowserWindow }, values) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(values.width, values.height); win.webContents.setZoomFactor(values.zoom) }, { width, height, zoom })
}
export async function playing(page: Page, minimum = 1, timeout = 45000) {
  await page.waitForFunction(min => { const v = document.querySelector('video'); return Boolean(v && (v as HTMLVideoElement).videoWidth > 0 && v.readyState >= 2 && !(v as HTMLVideoElement).paused && (v as HTMLVideoElement).currentTime >= min) }, minimum, { timeout })
  const before = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime), { timeout: 10000 }).toBeGreaterThan(before + .2)
}
export async function openFixturePlayer(page: Page, id = 'db-2001', episode = 1) {
  await page.evaluate(id => { location.hash = `#/detail/${id}` }, id)
  await page.locator('.detail__actions').waitFor()
  if (episode > 1) await page.locator(`a[href="#/play/${id}/${episode}"]`).first().click()
  else await page.locator(`.detail__actions a[href="#/play/${id}"]`).click()
  await playing(page)
}
// The player hides its controls while the pointer is stationary. Move the
// pointer onto the control's box first: the resulting pointermove wakes the
// overlay, and waiting for data-idle to clear avoids clicking the video layer
// that sits under the paused overlay.
export async function clickPlayerLocator(page: Page, control: ReturnType<Page['locator']>) {
  const box = await control.boundingBox()
  if (!box) throw new Error('Player control is not rendered')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => !document.querySelector('.player')?.hasAttribute('data-idle'))
  await control.click()
}

export async function clickPlayerControl(page: Page, name: string) {
  await clickPlayerLocator(page, page.getByRole('button', { name, exact: true }))
}

export async function choose(page: Page, label: string, value: string) {
  await clickPlayerControl(page, label)
  await page.getByRole('menuitemradio', { name: value, exact: true }).click()
}
export async function screenshot(page: Page, path: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
  try {
    await page.screenshot({ path, timeout: 10000 })
  } catch {
    // An inactive or occluded test window can withhold the compositor surface.
    // Capture without the surface so the replay evidence never blocks the run.
    const cdp = await page.context().newCDPSession(page)
    try {
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false })
      writeFileSync(path, Buffer.from(result.data, 'base64'))
    } finally { await cdp.detach() }
  }
}
export async function contrast(element: ReturnType<Page['locator']>) {
  return element.evaluate(e => {
    const rgba = (text: string) => { const v = text.match(/[\d.]+/g)!.map(Number); return [v[0], v[1], v[2], v[3] ?? 1] }
    const over = (a: number[], b: number[]) => { const alpha = a[3] + b[3] * (1 - a[3]); return [...a.slice(0, 3).map((v, i) => (v * a[3] + b[i] * b[3] * (1 - a[3])) / alpha), alpha] }
    const luma = (color: number[]) => { const [r, g, b] = color.slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }); return .2126 * r + .7152 * g + .0722 * b }
    const layers: number[][] = []
    for (let node: Element | null = e; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor))
    const bg = layers.reverse().reduce((base, layer) => over(layer, base), [0, 0, 0, 1])
    const fg = over(rgba(getComputedStyle(e).color), bg)
    return { ratio: (luma(fg) + .05) / (luma(bg) + .05), color: getComputedStyle(e).color, fontSize: getComputedStyle(e).fontSize }
  })
}
