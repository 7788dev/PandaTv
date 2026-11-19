// Startup timeline of the real application, in milliseconds after the process was created.
//   node scripts/probe-startup.mjs [firstStarts=5] [repeatStarts=3]
// Each first start uses an empty profile (nothing saved); the repeat starts reuse the last one.
// PANDA_E2E_EXECUTABLE selects a packaged or installed Panda.exe; otherwise the build in out/ runs.
// Needs the network. Writes docs/evidence/startup-timing.json.
import { _electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.tmp'), { recursive: true })
const firstStarts = Number(process.argv[2] ?? 5)
const repeatStarts = Number(process.argv[3] ?? 3)

async function start(profile) {
  const env = Object.fromEntries(Object.entries(process.env).filter(entry => typeof entry[1] === 'string'))
  env.PANDA_USER_DATA_DIR = profile
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: process.env.PANDA_E2E_EXECUTABLE, args: process.env.PANDA_E2E_EXECUTABLE ? [] : [root], cwd: root, env, timeout: 30000 })
  // What the main process reports about slow or failed artwork and metadata requests.
  const notices = []
  app.process().stdout?.on('data', chunk => { for (const line of String(chunk).split(/\r?\n/)) if (/^\[(image|metadata)\]/.test(line)) notices.push(line) })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const marks = await page.evaluate(() => new Promise(resolve => {
    const out = { origin: performance.timeOrigin }
    const tick = () => {
      const now = performance.now()
      const main = document.querySelector('main')
      if (main && out.skeleton === undefined) out.skeleton = now
      if (main && main.getAttribute('aria-busy') !== 'true' && out.data === undefined) { out.data = now; out.failed = !document.querySelector('.hero__title') }
      if (out.data !== undefined && out.artwork === undefined) {
        const visible = [...document.querySelectorAll('img.img')].filter(img => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth })
        if (visible.length && visible.every(img => img.complete && img.naturalWidth > 0)) { out.artwork = now; out.images = visible.length }
      }
      // The whole page: six sections below the featured titles.
      if (out.whole === undefined && document.querySelectorAll('main .section').length >= 6 && main?.getAttribute('aria-busy') !== 'true') out.whole = now
      if ((out.artwork !== undefined && out.whole !== undefined) || now > 60000) return resolve(out)
      setTimeout(tick, 16)
    }
    tick()
  }))
  const base = marks.origin - await app.evaluate(() => process.getCreationTime())
  await app.close()
  const at = value => value === undefined ? null : Math.round(base + value)
  return { skeleton: at(marks.skeleton), topOfPage: at(marks.data), visibleArtwork: at(marks.artwork), wholePage: at(marks.whole), visibleImages: marks.images ?? 0, failed: Boolean(marks.failed), ...(notices.length ? { notices } : {}) }
}

const result = { at: new Date().toISOString(), executable: process.env.PANDA_E2E_EXECUTABLE ?? 'out/', unit: 'ms after process creation', firstStarts: [], repeatStarts: [] }
let profile
for (let i = 0; i < firstStarts; i++) {
  profile = mkdtempSync(join(root, '.tmp', 'startup-'))
  result.firstStarts.push(await start(profile))
  console.log('first start ', JSON.stringify(result.firstStarts.at(-1)))
}
for (let i = 0; i < repeatStarts && profile; i++) {
  result.repeatStarts.push(await start(profile))
  console.log('repeat start', JSON.stringify(result.repeatStarts.at(-1)))
}
writeFileSync(join(root, 'docs/evidence/startup-timing.json'), JSON.stringify(result, null, 2))
