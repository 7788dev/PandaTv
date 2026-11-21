import { expect, test, type Page } from '@playwright/test'
import { capture, launch, playing } from './desktop'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

async function startFrameSample(page: Page, duration: number) {
  await page.evaluate(duration => {
    const gaps: number[] = []
    const longTasks: number[] = []
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)))
    observer.observe({ type: 'longtask' })
    ;(globalThis as any).__pandaUiAudit.frameSample = new Promise(resolve => {
      let start: number | undefined
      let last: number | undefined
      const frame = (now: number) => {
        start ??= now
        if (last !== undefined) gaps.push(now - last)
        last = now
        if (now - start < duration) requestAnimationFrame(frame)
        else {
          observer.disconnect()
          const sorted = [...gaps].sort((left, right) => left - right)
          resolve({ durationMs: now - start, frames: gaps.length, gapsMs: gaps,
            p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1),
            over20Ms: gaps.filter(gap => gap > 20).length, longTasksMs: longTasks,
            visibility: document.visibilityState, devicePixelRatio })
        }
      }
      requestAnimationFrame(frame)
    })
  }, duration)
}

test('packaged live: UI frame samples and player resource release after repeated navigation', async () => {
  test.skip(!process.env.PANDA_E2E_EXECUTABLE, 'Requires a packaged Panda.exe via PANDA_E2E_EXECUTABLE')
  const { app, page, errors } = await launch()
  try {
    await page.addInitScript(() => {
      const timers = new Map<number, { kind: string; delay: number; source: string }>()
      const timeout = window.setTimeout.bind(window)
      const interval = window.setInterval.bind(window)
      const clearTimeout = window.clearTimeout.bind(window)
      const clearInterval = window.clearInterval.bind(window)
      const source = () => new Error().stack?.split('\n').slice(2, 5).join('\n') ?? ''
      window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
        if (typeof handler !== 'function') return timeout(handler, delay, ...args)
        const handle = timeout(() => { timers.delete(handle); handler.apply(window, args) }, delay)
        timers.set(handle, { kind: 'timeout', delay, source: source() })
        return handle
      }) as typeof window.setTimeout
      window.setInterval = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
        const handle = interval(handler, delay, ...args)
        timers.set(handle, { kind: 'interval', delay, source: source() })
        return handle
      }) as typeof window.setInterval
      window.clearTimeout = handle => { if (typeof handle === 'number') timers.delete(handle); clearTimeout(handle) }
      window.clearInterval = handle => { if (typeof handle === 'number') timers.delete(handle); clearInterval(handle) }
      ;(globalThis as any).__pandaUiAudit = { timers, retiredPlayers: [], frameSample: undefined }
    })
    await page.reload()
    await expect(page.locator('.hero__title')).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    await page.evaluate(() => window.panda.user.dispatch({ type: 'settings', patch: { muted: true } }))
    const identity = await app.evaluate(({ app, BrowserWindow }) => ({
      path: app.getAppPath(), version: app.getVersion(), windows: BrowserWindow.getAllWindows().length,
    }))
    expect(identity.windows).toBe(1)
    const asarSha256 = createHash('sha256').update(await readFile(identity.path)).digest('hex').toUpperCase()
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    const harnessScripts = new Set<string>()
    const metrics = async () => {
      const values = await session.send('Performance.getMetrics')
      return Object.fromEntries(values.metrics.filter(metric => [
        'JSEventListeners', 'Nodes', 'Documents', 'JSHeapUsedSize', 'LayoutCount', 'RecalcStyleCount',
      ].includes(metric.name)).map(metric => [metric.name, metric.value]))
    }
    const roots = async () => {
      const counts: Record<string, Record<string, number>> = {}
      const harness: Record<string, Record<string, number>> = {}
      for (const target of ['window', 'document']) {
        const reference = await session.send('Runtime.evaluate', { expression: target, objectGroup: 'panda-ui-audit' })
        expect(reference.result.objectId).toBeTruthy()
        const result = await session.send('DOMDebugger.getEventListeners', { objectId: reference.result.objectId! })
        for (const listener of result.listeners) {
          if (listener.type === '__playwright_global_listeners_check__') harnessScripts.add(listener.scriptId)
        }
        counts[target] = {}
        harness[target] = {}
        for (const listener of result.listeners) {
          const group = harnessScripts.has(listener.scriptId) ? harness[target] : counts[target]
          const key = `${listener.type}:${listener.useCapture}`
          group[key] = (group[key] ?? 0) + 1
        }
      }
      await session.send('Runtime.releaseObjectGroup', { objectGroup: 'panda-ui-audit' })
      return { application: counts, playwright: harness }
    }
    const resourceState = async () => {
      await page.requestGC()
      return { metrics: await metrics(), roots: await roots(), ...await page.evaluate(() => {
        const audit = (globalThis as any).__pandaUiAudit
        return {
          activeTimers: [...audit.timers.values()],
          retainedPlayers: audit.retiredPlayers.map((refs: { root: WeakRef<Element>; video: WeakRef<Element> }) => ({
            root: Boolean(refs.root.deref()), video: Boolean(refs.video.deref()),
          })),
        }
      }) }
    }
    const samples: unknown[] = []
    await startFrameSample(page, 1800)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('combobox')).toBeFocused()
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    samples.push({ name: 'search-open-close', ...await page.evaluate(() => (globalThis as any).__pandaUiAudit.frameSample) })
    await startFrameSample(page, 1800)
    await page.locator('.card').first().hover()
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(500)
    await page.mouse.wheel(0, -600)
    samples.push({ name: 'poster-hover-scroll', ...await page.evaluate(() => (globalThis as any).__pandaUiAudit.frameSample) })
    const openSettings = async () => {
      await page.evaluate(() => { location.hash = '#/settings' })
      await expect(page.getByRole('button', { name: '默认倍速', exact: true })).toBeVisible()
      await page.waitForTimeout(1000)
    }
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await openSettings()
    const before = await resourceState()
    const checkpoints: Awaited<ReturnType<typeof resourceState>>[] = []
    for (let cycle = 0; cycle < 6; cycle++) {
      if (cycle === 0) await startFrameSample(page, 1500)
      await page.evaluate(() => { location.hash = '#/detail/db-26647087' })
      await expect(page.locator('.detail__title')).toHaveText('三体')
      await expect.poll(() => page.locator('.eps a').count(), { timeout: 30000 }).toBeGreaterThan(1)
      if (cycle === 0) samples.push({ name: 'detail-enter', ...await page.evaluate(() => (globalThis as any).__pandaUiAudit.frameSample) })
      await page.locator('.eps a').first().click()
      await playing(page)
      await page.keyboard.press('k')
      await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(true)
      const trigger = page.getByRole('button', { name: '选集', exact: true })
      await trigger.focus()
      if (cycle === 0) await startFrameSample(page, 1500)
      await page.keyboard.press('Enter')
      const drawer = page.locator('.player__panel[data-open]')
      await expect(drawer.locator('[data-current]')).toBeFocused()
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
      await expect(drawer).not.toBeVisible()
      await expect(trigger).toBeFocused()
      if (cycle === 0) samples.push({ name: 'episode-open-close', ...await page.evaluate(() => (globalThis as any).__pandaUiAudit.frameSample) })
      await page.evaluate(() => {
        const root = document.querySelector('.player')!
        const video = root.querySelector('video')!
        ;(globalThis as any).__pandaUiAudit.retiredPlayers.push({ root: new WeakRef(root), video: new WeakRef(video) })
      })
      await openSettings()
      if (cycle === 2 || cycle === 5) checkpoints.push(await resourceState())
    }
    await expect.poll(async () => {
      await page.requestGC()
      return page.evaluate(() => (globalThis as any).__pandaUiAudit.retiredPlayers.every(
        (refs: { root: WeakRef<Element>; video: WeakRef<Element> }) => !refs.root.deref() && !refs.video.deref(),
      ))
    }).toBe(true)
    const after = await resourceState()
    const timerKinds = (state: typeof before) => state.activeTimers.map((timer: { kind: string; delay: number }) => `${timer.kind}:${timer.delay}`).sort()
    await capture(page, 'ui-performance-lifecycle', { at: new Date().toISOString(), identity, asarSha256,
      scope: 'Visible Electron renderer; finite six-cycle sample, not a long-duration or target-TV guarantee.',
      samples, before, checkpoints, after, harnessScriptIds: [...harnessScripts] })
    expect(after.roots.application).toEqual(before.roots.application)
    expect(checkpoints[1]!.roots).toEqual(checkpoints[0]!.roots)
    expect(timerKinds(after)).toEqual(timerKinds(before))
    expect(errors).toEqual([])
    await session.detach()
  } finally { await app.close() }
})
