import { defineConfig } from '@playwright/test'
import { join } from 'node:path'

const liveRuntime = process.env.PANDA_E2E_EXECUTABLE ? 'desktop-packaged-live' : 'desktop-build-live'
const reportScope = process.env.npm_lifecycle_event === 'test:e2e:fixture' ? 'desktop-fixture'
  : process.env.npm_lifecycle_event === 'test:e2e' ? liveRuntime : 'combined'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 180000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  projects: [
    { name: 'desktop-live', testMatch: '**/*.live.spec.ts', outputDir: join('.tmp/e2e-results', liveRuntime) },
    { name: 'desktop-fixture', testMatch: '**/*.fixture.spec.ts', outputDir: '.tmp/e2e-results/desktop-fixture' },
  ],
  preserveOutput: 'failures-only',
  reporter: [['list'], ['json', { outputFile: join('.tmp/e2e-reports', reportScope + '.json') }], ['html', { outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || join('.tmp/playwright-report', reportScope), open: 'never', title: `Panda E2E — ${reportScope}` }]],
})
