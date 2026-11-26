import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { choose, clickPlayerControl, playing, resize, screenshot } from './quality-desktop'
import { extra } from '../src/copy.extra'

let app: ElectronApplication, page: Page, dir: string
const errors: string[] = []
const logs: Array<{ at: number; process: string; message: string }> = []
test.beforeEach(async ({}, info) => {
  dir = resolve('.tmp/quality-live', info.title.replace(/[^a-z0-9]/gi, '-').slice(0, 60) + '-' + Date.now())
  mkdirSync(dir, { recursive: true }); errors.length = 0; logs.length = 0
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'PANDA_E2E_NETWORK_ORIGIN', 'PANDA_SOURCE_CONFIG', 'ELECTRON_RENDERER_URL']) delete env[key]
  env.PANDA_USER_DATA_DIR = join(dir, 'user-data')
  const audioArgs = process.env.PANDA_E2E_SILENT_OUTPUT === '2' ? ['--disable-audio-output'] : []
  const extraArgs = (process.env.PANDA_E2E_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)
  const executablePath = process.env.PANDA_E2E_EXECUTABLE ? resolve(process.env.PANDA_E2E_EXECUTABLE) : undefined
  app = await _electron.launch({ executablePath, args: [...extraArgs, ...audioArgs, ...(executablePath ? [] : [process.cwd()])], env, cwd: process.cwd(), timeout: 30000 })
  app.on('console', message => logs.push({ at: Date.now(), process: 'main', message: message.text() }))
  page = await app.firstWindow()
  page.on('console', message => logs.push({ at: Date.now(), process: 'renderer', message: message.text() }))
  page.on('pageerror', error => errors.push(String(error)))
  await page.locator('.topbar').waitFor()
  const runtime = await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), executable: app.getPath('exe'), packaged: app.isPackaged, versions: process.versions }))
  expect(runtime.packaged).toBe(Boolean(executablePath))
  writeFileSync(join(dir, 'runtime-identity.json'), JSON.stringify({ ...runtime, frontend: page.url(),
    executableSha256: createHash('sha256').update(readFileSync(runtime.executable)).digest('hex'),
    audioOutput: audioArgs.length ? audioArgs[0] : 'default', input: 'Real network; isolated user data',
  }, null, 2))
})
test.afterEach(async ({}, info) => {
  if (!app) return
  if (info.status !== info.expectedStatus) await screenshot(page, join(dir, 'failure.png')).catch(() => {})
  writeFileSync(join(dir, 'page-errors.json'), JSON.stringify(errors))
  writeFileSync(join(dir, 'runtime-logs.json'), JSON.stringify(logs.map(value => ({ ...value, message: value.message.replace(/https?:\/\/\S+/g, '<redacted-url>') })), null, 2))
  try { expect(errors).toEqual([]) } finally { await app.close() }
})

test('real metadata initials filters paging and detail navigation', async () => {
  const report: Record<string, unknown> = { at: new Date().toISOString(), runtime: process.env.PANDA_E2E_EXECUTABLE ? 'production packaged executable with real network' : 'current production build with real network' }
  await page.locator('.hero__title').waitFor({ timeout: 45000 })
  await screenshot(page, join(dir, 'home-live.png'))
  await resize(app, 1080, 640, 1.5)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
  await screenshot(page, join(dir, 'home-compact-live.png'), app)
  await resize(app, 1440, 900)
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('ST')
  await page.keyboard.press('Enter')
  const tri = page.locator('a[href="#/detail/db-26647087"]').first()
  await tri.waitFor({ timeout: 45000 })
  expect(await tri.innerText()).toContain('三体')
  report.search = await page.evaluate(() => window.panda.data.search('ST').then(rows => rows.map(({ id, title, type, year }) => ({ id, title, type, year }))))
  await tri.click(); await page.locator('.detail__actions').waitFor({ timeout: 45000 })
  await expect(page.getByRole('heading', { name: '三体', exact: true })).toBeVisible()
  await screenshot(page, join(dir, 'detail-live.png'))
  await page.locator('a[href="#/channel/movie"]').click()
  await page.locator('.grid .card').first().waitFor({ timeout: 45000 })
  const first = await page.locator('.grid .card').count()
  const viewport = page.locator('.scroll__viewport')
  await viewport.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => page.locator('.grid .card').count(), { timeout: 45000 }).toBeGreaterThan(first)
  report.channel = { first, after: await page.locator('.grid .card').count() }
  await resize(app, 1080, 640)
  await screenshot(page, join(dir, 'channel-small-live.png'))
  writeFileSync(join(dir, 'metadata-live.json'), JSON.stringify(report, null, 2))
})

test('real playback episode source seek exit reentry and media resource release', async () => {
  const report: Record<string, unknown> = { at: new Date().toISOString() }
  const checkpoint = () => writeFileSync(join(dir, 'playback-live-progress.json'), JSON.stringify(report, null, 2))
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('三体'); await page.keyboard.press('Enter')
  const target = page.locator('a[href="#/detail/db-26647087"]').first()
  await target.waitFor({ timeout: 45000 }); await target.click()
  await page.locator('.detail__actions').waitFor({ timeout: 45000 })
  const initial = await page.evaluate(() => window.panda.data.subject('db-26647087'))
  expect(initial.title).toBe('三体'); expect(initial.year).toBe(2023)
  expect(initial.region).toContain('中国大陆')
  report.subject = { id: initial.id, title: initial.title, year: initial.year, region: initial.region }
  const availability = await page.evaluate(() => window.panda.data.availability('db-26647087'))
  expect(availability.episodes).toBe(30)
  report.availability = availability
  checkpoint()
  const started = Date.now()
  await page.locator('.detail__actions a[href="#/play/db-26647087"]').click()
  await playing(page, 2, 90000)
  report.startupMs = Date.now() - started
  report.firstSource = await page.evaluate(() => window.panda.data.sources('db-26647087', 1))
  checkpoint()
  await screenshot(page, join(dir, 'episode-1-live.png'))
  await clickPlayerControl(page, '下一集')
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/play/db-26647087/2')
  await playing(page, 2, 90000)
  const available = await page.evaluate(() => window.panda.data.sources('db-26647087', 2))

  const attempts: Array<Record<string, unknown>> = []
  report.sourceAttempts = attempts
  test.setTimeout(180000 + available.list.length * 45000)
  for (const alternative of available.list) {
    const before = await page.evaluate(() => window.panda.data.sources('db-26647087', 2))
    if (alternative.key === before.current) continue
    const beforePosition = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)
    const previousMedia = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentSrc)
    const switchStarted = Date.now()
    const withheld = () => logs.find(entry => entry.at >= switchStarted && entry.process === 'renderer' &&
      entry.message.startsWith('[alignment] ' + alternative.key + ' '))
    await choose(page, '线路', alternative.name)
    try {
      await expect.poll(async () => {
        if (withheld()) return true
        return await page.evaluate(() => window.panda.data.sources('db-26647087', 2).then(value => value.current)) === alternative.key
      }, { timeout: 45000 }).toBe(true)
      const refusal = withheld()
      if (refusal) {
        await expect(page.getByText(extra.lineSwitchFailed, { exact: true }).first()).toBeVisible()
        expect(await page.evaluate(() => window.panda.data.sources('db-26647087', 2).then(s => s.current))).toBe(before.current)
        expect(await page.locator('.player__video').evaluate(v => (v as HTMLVideoElement).currentSrc)).toBe(previousMedia)
        await playing(page, beforePosition + 1, 15000)
        await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
        attempts.push({ requested: alternative, outcome: 'alignment withheld', reason: refusal.message, retained: before.current })
        checkpoint()
        continue
      }
      await page.waitForFunction(previous => {
        const v = document.querySelector('video')
        return Boolean(v && v.currentSrc && v.currentSrc !== previous && v.readyState >= 2 && v.videoWidth > 0 && !v.paused)
      }, previousMedia, { timeout: 15000 })
      await playing(page, beforePosition - 1, 15000)
      const afterSwitch = await page.evaluate(() => window.panda.data.sources('db-26647087', 2))
      expect(afterSwitch.current).toBe(alternative.key)
      report.switchedSource = afterSwitch
      report.sourceSwitchMs = Date.now() - switchStarted
      report.switchedMedia = await page.locator('video').evaluate(v => ({ source: (v as HTMLVideoElement).currentSrc, position: (v as HTMLVideoElement).currentTime }))
      attempts.push({ requested: alternative, outcome: 'switched', after: afterSwitch, elapsedMs: report.sourceSwitchMs })
      checkpoint()
      break
    } catch (error) {
      if (withheld()) throw error
      const failures = logs.filter(value => value.at >= switchStarted && value.process === 'main' && value.message.includes(alternative.key) && value.message.includes('probe:')).map(value => value.message.replace(/https?:\/\/\S+/g, '<redacted-url>'))
      if (!failures.length) throw error
      const after = await page.evaluate(() => window.panda.data.sources('db-26647087', 2))
      expect(after.current).not.toBe(alternative.key)
      await playing(page, beforePosition - 1, 15000)
      await expect(page.locator('.player')).not.toHaveAttribute('data-error', '')
      const video = await page.locator('video').evaluate(v => ({ source: (v as HTMLVideoElement).currentSrc, position: (v as HTMLVideoElement).currentTime }))
      attempts.push({ requested: alternative, outcome: 'upstream-unavailable; playback fallback remained active', failures,
        after, video, elapsedMs: Date.now() - switchStarted, observerFailure: String(error) })
      await screenshot(page, join(dir, `source-${alternative.key}-fallback.png`))
      checkpoint()
    }
  }
  if (!report.switchedSource) report.sourceSwitchUnavailable = { reason: attempts.length ? 'Alternatives failed probing or alignment; playback stayed active' : 'Only one catalogue was selectable', available, attempts }
  const seekAt = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)
  const seekStarted = Date.now()
  await page.locator('.seek').focus(); await page.keyboard.press('PageUp')
  await playing(page, seekAt + 58, 90000)
  report.seekMs = Date.now() - seekStarted
  await screenshot(page, join(dir, 'episode-2-seek-live.png'))
  await clickPlayerControl(page, '暂停')
  const paused = await page.locator('video').evaluate(v => ({ currentTime: (v as HTMLVideoElement).currentTime, paused: (v as HTMLVideoElement).paused, frames: (v as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames, dropped: (v as HTMLVideoElement).getVideoPlaybackQuality().droppedVideoFrames }))
  expect(paused.paused).toBe(true); expect(paused.frames).toBeGreaterThan(0)
  report.decoding = paused
  await clickPlayerControl(page, '返回')
  await page.locator('.detail__actions').waitFor()
  expect(await page.locator('video').count()).toBe(0)
  const history = await page.evaluate(() => window.panda.user.get().then(user => user.history.find(entry => entry.id === 'db-26647087')))
  expect(history?.episode).toBe(2); expect(history!.position).toBeGreaterThan(55)
  report.history = history
  await page.locator('.detail__actions a[href^="#/play/db-26647087"]').click()
  await playing(page, history!.position - 2, 90000)
  await screenshot(page, join(dir, 'resume-live.png'))
  report.resumedSource = await page.evaluate(() => window.panda.data.sources('db-26647087', 2))
  report.resumedAt = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)
  writeFileSync(join(dir, 'playback-live.json'), JSON.stringify(report, null, 2))
})
