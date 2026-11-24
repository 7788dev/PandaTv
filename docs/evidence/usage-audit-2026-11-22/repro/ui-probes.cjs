const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { _electron, expect } = require('@playwright/test');

const root = process.cwd();
const output = join(root, '.tmp', 'usage-audit-2026-11-22');
const round = process.argv[2] || 'first';
const mainPath = join(output, 'extended-fixture-main.cjs');
let main = readFileSync(join(root, 'e2e', 'fixture-main.cjs'), 'utf8');
main = main.replace("const root = resolve(__dirname, '..');", 'const root = process.env.PANDA_AUDIT_ROOT;');
main = main.replace("const catalog = require('../design/mock/catalog.json');", `const originalCatalog = require(join(root, 'design/mock/catalog.json'));
const example = originalCatalog.items.find(item => item.type === 'tv');
const catalog = { ...originalCatalog, items: [...originalCatalog.items, ...Array.from({ length: 120 }, (_, index) => ({ ...example, id: 'db-' + (1000000 + index), title: 'Audit title ' + (1000000 + index) }))] };`);
main = main.replace("require('../design/mock/source.ts')", "require(join(root, 'design/mock/source.ts'))");
main = main.replace("require('../design/copy/zh-CN.json')", "require(join(root, 'design/copy/zh-CN.json'))");
main = main.replace("join(__dirname, 'fixtures',", "join(root, 'e2e', 'fixtures',");
main = main.replace("if (operation === 'titleHints') return [];", `if (operation === 'titleHints') return [];
    if (operation === 'person') return { id: args[0], name: 'Audit person' };
    if (operation === 'personWorks') return source.channel('tv', { sort: 'hot' }, args[1]);`);
writeFileSync(mainPath, main, 'utf8');

async function launch() {
  const profile = mkdtempSync(join(output, `ui-${round}-`));
  const env = { ...process.env, PANDA_AUDIT_ROOT: root, PANDA_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PANDA_FIXTURE_APP_PATH;
  delete env.PANDA_FIXTURE_PAGE_SIZE;
  const app = await _electron.launch({ args: [mainPath], cwd: root, env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1080, height: 640 });
  await expect(page.locator('.hero__title')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isVisible())), [false]);
  return { app, page, errors };
}

async function waitPlaying(page) {
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && !v.paused && v.readyState >= 2 && v.currentTime > 0.1 && v.getVideoPlaybackQuality().totalVideoFrames >= 3;
  }, null, { timeout: 20000 });
}

async function paginationProbe(route, label) {
  const { app, page, errors } = await launch();
  try {
    await page.evaluate(route => { location.hash = route; }, route);
    const cards = page.locator('.grid--poster .card');
    await expect.poll(() => cards.count()).toBe(30);
    const viewport = page.locator('.scroll__viewport');
    while (await cards.count() < 90) {
      const count = await cards.count();
      await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect.poll(() => cards.count(), { timeout: 10000 }).toBeGreaterThan(count);
    }
    const chosen = cards.nth(85);
    await chosen.scrollIntoViewIfNeeded();
    const chosenLink = chosen.locator('.card__link');
    await chosenLink.focus();
    await page.waitForTimeout(150);
    const href = await chosenLink.getAttribute('href');
    const title = await chosen.locator('.card__title').textContent();
    const before = { count: await cards.count(), top: await viewport.evaluate(element => element.scrollTop), href, title };
    await page.screenshot({ path: join(output, `${label}-${round}-before.png`) });
    await chosenLink.click();
    await expect(page.locator('.detail__title')).toHaveText(title);
    await page.getByRole('button', { name: '返回', exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(route);
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(30);
    await page.waitForTimeout(1200);
    const after = { count: await cards.count(), top: await viewport.evaluate(element => element.scrollTop), chosenCardPresent: await page.locator(`.grid--poster a[href="${href}"]`).count() };
    await page.screenshot({ path: join(output, `${label}-${round}-after.png`) });
    assert.equal(after.chosenCardPresent, 0);
    assert(after.count < before.count);
    assert(before.top - after.top > 500);
    assert.deepEqual(errors, []);
    return { scenario: `${label}-return-loses-loaded-pages-and-scroll`, renderer: 'current compiled production renderer, hidden window', data: 'extended isolated fixture catalogue', before, after, screenshots: [`${label}-${round}-before.png`, `${label}-${round}-after.png`] };
  } finally { await app.close(); }
}

async function preferenceProbe() {
  const { app, page, errors } = await launch();
  try {
    await app.evaluate(() => globalThis.__fixture.setUser({ history: [], settings: { skipIntro: false, muted: true, speed: 1, quality: '720P' } }));
    await page.evaluate(() => { location.hash = '#/play/changye-jiangming/1'; });
    await waitPlaying(page);
    await page.getByRole('button', { name: '倍速', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitemradio', { name: '2.0×', exact: true }).click();
    await page.getByRole('button', { name: '清晰度', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitemradio', { name: '480P', exact: true }).click();
    await waitPlaying(page);
    await expect.poll(() => page.locator('video').evaluate(video => video.playbackRate)).toBe(2);
    await expect.poll(() => page.locator('video').evaluate(video => video.videoWidth)).toBe(640);
    await page.getByRole('button', { name: '返回', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '默认倍速', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '1.5×', exact: true }).click();
    await page.getByRole('button', { name: '默认清晰度', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '720P', exact: true }).click();
    const saved = await page.evaluate(() => window.panda.user.get());
    assert.equal(saved.settings.speed, 1.5);
    assert.equal(saved.settings.quality, '720P');
    const original = require(join(root, 'design/mock/catalog.json'));
    const movie = original.items.find(item => item.type === 'movie');
    await page.evaluate(id => { location.hash = '#/play/' + id; }, movie.id);
    await waitPlaying(page);
    const next = await page.locator('video').evaluate(video => ({ rate: video.playbackRate, width: video.videoWidth }));
    const playbackCalls = await app.evaluate(() => globalThis.__fixture.calls.filter(call => call.method === 'data.playback'));
    assert.notEqual(next.rate, saved.settings.speed);
    assert.equal(next.width, 640);
    assert.deepEqual(errors, []);
    return { scenario: 'new-settings-defaults-overridden-by-previous-player-session', savedDefaults: { speed: saved.settings.speed, quality: saved.settings.quality }, nextMovie: { id: movie.id, ...next, requestedQuality: playbackCalls.at(-1)?.args[2] }, evidence: 'actual menu actions and native video state, compiled renderer with local MP4' };
  } finally { await app.close(); }
}

(async () => {
  const scope = process.argv[3] || 'all';
  const observations = scope === 'preferences' ? JSON.parse(readFileSync(join(output, `ui-probes-${round}.json`), 'utf8')).observations.filter(item => !item.scenario.startsWith('new-settings')) : [];
  const save = () => writeFileSync(join(output, `ui-probes-${round}.json`), JSON.stringify({ at: new Date().toISOString(), round, observations }, null, 2), 'utf8');
  if (scope === 'all') {
    observations.push(await paginationProbe('#/channel/tv', 'channel'));
    save();
    observations.push(await paginationProbe('#/person/1', 'person'));
    save();
  }
  observations.push(await preferenceProbe());
  const report = { at: new Date().toISOString(), round, observations };
  writeFileSync(join(output, `ui-probes-${round}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
