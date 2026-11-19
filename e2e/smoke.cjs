const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
  const env = { ...process.env, PANDA_USER_DATA_DIR: await fs.mkdtemp(path.join(root, '.tmp', 'smoke-')) };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [root], cwd: root, env, timeout: 20000 });
    console.log('main connected');
    app.process().stderr.on('data', data => process.stderr.write(data));
    const page = await app.firstWindow({ timeout: 20000 });
    console.log('window connected');
    const errors = [];
    const consoleErrors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 180)); });
    await page.waitForSelector('.hero__title', { timeout: 30000 });
    console.log('home populated');
    await page.waitForFunction(() => [...document.images].filter(i => i.src.startsWith('http:') && i.naturalWidth > 0).length > 5, undefined, { timeout: 20000 }).catch(() => {});
    await page.evaluate(async () => { await document.fonts.ready; });
    console.log('fonts ready');
    await fs.mkdir(path.join(root, 'docs/evidence/runtime'), { recursive: true });
    const label = process.env.SMOKE_LABEL || 'startup';
    await page.screenshot({ path: path.join(root, `docs/evidence/runtime/${label}.png`) });
    const loadedImages = await page.evaluate(() => [...document.images].filter(i => i.src.startsWith('http:') && i.naturalWidth > 0).length);
    const result = { url: page.url(), title: await page.locator('.hero__title').innerText(), loadedImages, errors, consoleErrors };
    await fs.writeFile(path.join(root, `docs/evidence/runtime/${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert.ok(loadedImages > 5, 'Real remote posters must load through the main-process proxy');
    assert.equal(consoleErrors.filter(e => e.startsWith('Loading the font')).length, 0, 'Packaged fonts must satisfy CSP');
    assert.deepEqual(errors, []);
  } finally { await app?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
