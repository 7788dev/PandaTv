const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { _electron, expect } = require('@playwright/test');
const root = process.cwd();
const output = join(root, '.tmp', 'usage-audit-2026-11-22');

async function ready(page, width) {
  await page.waitForFunction(width => {
    const video = document.querySelector('video');
    return video && video.videoWidth === width && !video.paused && video.readyState >= 3 && video.currentTime > 0.2 && video.getVideoPlaybackQuality().totalVideoFrames > 3;
  }, width, { timeout: 12000 });
}

(async () => {
  const cases = [];
  for (let round = 1; round <= 2; round++) {
    const env = { ...process.env, PANDA_AUDIT_ROOT: root, PANDA_USER_DATA_DIR: mkdtempSync(join(output, 'speed-load-')) };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PANDA_FIXTURE_APP_PATH;
    const app = await _electron.launch({ args: [join(output, 'extended-fixture-main.cjs')], cwd: root, env });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(12000);
      await expect(page.locator('.hero__title')).toBeVisible();
      await page.evaluate(() => {
        window.__rateAudit = [];
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', { ...descriptor, set(value) {
          window.__rateAudit.push({ event: 'script-assignment', value, src: this.currentSrc, at: performance.now() });
          descriptor.set.call(this, value);
        } });
        for (const name of ['ratechange', 'loadstart', 'loadedmetadata', 'playing']) addEventListener(name, event => {
          if (event.target?.tagName === 'VIDEO') window.__rateAudit.push({ event: name, value: event.target.playbackRate, defaultRate: event.target.defaultPlaybackRate, at: performance.now() });
        }, true);
      });
      await app.evaluate(() => globalThis.__fixture.setUser({ history: [], settings: { speed: 1.5, quality: '720P', muted: true, skipIntro: false } }));
      await page.evaluate(() => { location.hash = '#/play/changye-jiangming/1'; });
      await ready(page, 1280);
      const initial = await page.locator('video').evaluate(video => ({ rate: video.playbackRate, defaultRate: video.defaultPlaybackRate, width: video.videoWidth }));
      const initialLabel = await page.getByRole('button', { name: '倍速', exact: true }).textContent();
      assert.equal(initial.rate, 1);
      assert.equal(initialLabel, '1.5×');
      await page.getByRole('button', { name: '倍速', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitemradio', { name: '2.0×', exact: true }).click();
      await expect.poll(() => page.locator('video').evaluate(video => video.playbackRate)).toBe(2);
      const manualRate = await page.locator('video').evaluate(video => video.playbackRate);
      await page.getByRole('button', { name: '清晰度', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitemradio', { name: '480P', exact: true }).click();
      await ready(page, 640);
      const reloaded = await page.locator('video').evaluate(video => ({ rate: video.playbackRate, defaultRate: video.defaultPlaybackRate, width: video.videoWidth }));
      const reloadedLabel = await page.getByRole('button', { name: '倍速', exact: true }).textContent();
      const trace = await page.evaluate(() => window.__rateAudit);
      assert.equal(reloaded.rate, 1);
      assert.equal(reloadedLabel, '2.0×');
      assert(trace.some(entry => entry.event === 'script-assignment' && entry.value === 1.5));
      assert(!trace.some(entry => entry.event === 'script-assignment' && entry.value === 1));
      cases.push({ at: new Date().toISOString(), round, savedDefaultSpeed: 1.5, initial, initialLabel, manualRate, reloaded, reloadedLabel, trace, evidence: 'fresh production renderer session and real local MP4; script setter trace distinguishes native load reset from an app assignment or auto adaptation' });
    } finally { await app.close(); }
  }
  const report = { cases };
  writeFileSync(join(output, 'speed-load-probe.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(cases.map(({ trace, ...item }) => ({ ...item, traceEntries: trace.length })), null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
