import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const root = resolve(__dirname, '..')
export const evidenceDir = join(root, 'docs/evidence/runtime')
export async function launch(profile?: string): Promise<{ app: ElectronApplication; page: Page; profile: string; errors: string[]; logs: string[] }> {
  await mkdir(join(root, '.tmp'), { recursive: true })
  const userData = profile ?? await mkdtemp(join(root, '.tmp', 'desktop-'))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  env.PANDA_USER_DATA_DIR = userData
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: process.env.PANDA_E2E_EXECUTABLE,
    args: process.env.PANDA_E2E_EXECUTABLE ? [] : [root],
    cwd: root, env, timeout: 30000,
  })
  console.log('Electron connected:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, url: window.webContents.getURL() }))))
  const page = await app.firstWindow()
  const errors: string[] = [], logs: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  app.process().stdout?.on('data', chunk => logs.push(String(chunk).slice(0, 1000)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.panda))
  console.log('Renderer bridge ready')
  return { app, page, profile: userData, errors, logs }
}
export async function capture(page: Page, name: string, result?: unknown) {
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, name + '.png') })
  if (result !== undefined) await writeFile(join(evidenceDir, name + '.json'), JSON.stringify(result, null, 2))
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
