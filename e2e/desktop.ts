import { _electron, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(__dirname, '..')
export const evidenceRoot = resolve(root, process.env.PANDA_E2E_EVIDENCE_DIR || '.tmp/e2e-evidence')
const runtime = process.env.PANDA_E2E_EXECUTABLE ? 'desktop-packaged-live' : 'desktop-build-live'
export const evidenceDir = join(evidenceRoot, runtime)
export const temporaryProfile = () => mkdtemp(test.info().outputPath('profile-'))
export async function launch(profile?: string): Promise<{ app: ElectronApplication; page: Page; profile: string; errors: string[]; logs: string[] }> {
  const userData = profile ?? await temporaryProfile()
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  env.PANDA_USER_DATA_DIR = userData
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await _electron.launch({
    executablePath: process.env.PANDA_E2E_EXECUTABLE,
    args: process.env.PANDA_E2E_EXECUTABLE ? [] : [root],
    cwd: root, env, timeout: 30000,
  })
  try {
    const logs: string[] = [], errors: string[] = []
    app.process().stdout?.on('data', chunk => logs.push(String(chunk).slice(0, 1000)))
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    app.on('window', extra => { if (extra !== page) errors.push(`Unexpected application window: ${extra.url()}`) })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.panda))
    const identity = await app.evaluate(({ app, BrowserWindow }) => ({
      path: app.getAppPath(), packaged: app.isPackaged, windows: BrowserWindow.getAllWindows().length,
    }))
    const expectedPath = process.env.PANDA_E2E_EXECUTABLE
      ? join(resolve(await realpath(process.env.PANDA_E2E_EXECUTABLE), '..'), 'resources', 'app.asar') : root
    if (identity.windows !== 1 || identity.packaged !== Boolean(process.env.PANDA_E2E_EXECUTABLE) ||
        resolve(identity.path) !== resolve(expectedPath) ||
        fileURLToPath(page.url()) !== join(identity.path, 'out', 'renderer', 'index.html')) {
      throw new Error(`Wrong renderer for ${runtime}: ${page.url()} (${JSON.stringify(identity)})`)
    }
    console.log(`${runtime}: ${page.url()}`)
    return { app, page, profile: userData, errors, logs }
  } catch (error) {
    await app.close()
    throw error
  }
}
export async function capture(page: Page, name: string, result?: unknown) {
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, name + '.png') })
  if (result !== undefined) await writeFile(join(evidenceDir, name + '.json'), JSON.stringify({
    ...(typeof result === 'object' && result !== null ? result : { result }),
    runtime,
    renderer: page.url(),
  }, null, 2))
}
export async function videoStatus(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector('video')!
    const quality = video.getVideoPlaybackQuality()
    return {
      position: video.currentTime, duration: video.duration,
      width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
      paused: video.paused, rate: video.playbackRate, volume: video.volume, muted: video.muted,
      decodedFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames,
      error: video.error?.message,
    }
  })
}
export async function playing(page: Page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('video')
    return Boolean(video && video.currentTime > 1 && video.videoWidth > 0 && video.readyState >= 3 && !video.paused)
  }, undefined, { timeout: 65000 })
}
