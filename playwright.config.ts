import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 180000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'docs/evidence/e2e-report', open: 'never' }]],
  outputDir: '.tmp/e2e-results',
})
