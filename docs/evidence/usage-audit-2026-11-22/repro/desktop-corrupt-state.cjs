const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { _electron, expect } = require('@playwright/test');

const root = process.cwd();
const output = join(root, '.tmp', 'usage-audit-2026-11-22');
const digest = value => createHash('sha256').update(value).digest('hex');

(async () => {
  const cases = [];
  for (let index = 0; index < 2; index++) {
    const profile = mkdtempSync(join(output, 'corrupt-profile-'));
    const file = join(profile, 'user-v1.json');
    const original = '{"favorites":["db-1292052"],"history":[],"searches":[],"settings":';
    writeFileSync(file, original, 'utf8');
    const env = { ...process.env, PANDA_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    const app = await _electron.launch({ args: [root], cwd: root, env });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(12000);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
      await expect(page.locator('.empty__text')).toHaveText('操作失败，请重试');
      const reads = [];
      for (let retry = 0; retry < 3; retry++) {
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await page.waitForTimeout(100);
        await expect(page.locator('.empty__text')).toHaveText('操作失败，请重试');
        reads.push(await page.evaluate(async () => { try { await window.panda.user.get(); return 'ok'; } catch (error) { return error.message; } }));
      }
      await page.getByRole('link', { name: '设置', exact: true }).click();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/settings');
      await expect(page.locator('.empty__text')).toHaveText('操作失败，请重试');
      const settingsVisible = await page.locator('.settings__body').count();
      await page.getByRole('link', { name: '电影', exact: true }).click();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/channel/movie');
      await expect(page.locator('.empty__text')).toHaveText('操作失败，请重试');
      const channelCards = await page.locator('.grid--poster .card').count();
      assert.equal(settingsVisible, 0);
      assert.equal(channelCards, 0);
      assert(reads.every(value => value === '操作失败，请重试'));
      assert.equal(readFileSync(file, 'utf8'), original);
      const identity = await app.evaluate(({ app }) => ({ appPath: app.getAppPath(), packaged: app.isPackaged, userDataPath: app.getPath('userData') }));
      await page.screenshot({ path: join(output, `corrupt-state-build-${index + 1}.png`) });
      cases.push({ at: new Date().toISOString(), identity, retryReads: reads, settingsVisible, channelCards, originalMalformedFilePreserved: true, stateFileSha256: digest(original), runtime: 'actual main/preload/current renderer with isolated damaged user state; hidden window' });
    } finally { await app.close(); }
  }
  const result = { cases };
  writeFileSync(join(output, 'desktop-corrupt-state.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
