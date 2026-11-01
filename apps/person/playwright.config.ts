import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks for the person app, run against the real static export served locally, with a real service
 * worker and the real API on an in-process database. `pnpm gate:phase2` builds the export, starts both servers and
 * runs this; running `playwright test` by hand needs the E2E_* variables it sets.
 *
 * Hard limits: 60 s per test, 9 minutes for the whole run. One worker, no retries, so a red is a red.
 */
export default defineConfig({
  testDir: './e2e',
  // An explicit registry of spec files: a spec that is not listed here does not run, and the gate fails if the
  // report does not hold exactly the tests in e2e/acceptance.json.
  testMatch: ['exit-acceptance.spec.ts'],
  timeout: 60_000,
  globalTimeout: 540_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-report.json' }]],
  outputDir: 'test-results/e2e',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3450',
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }],
});
