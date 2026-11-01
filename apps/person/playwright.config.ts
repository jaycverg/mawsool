import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks for the person app, run against the real static export served locally, with a real service
 * worker and the real API on an in-process database. `pnpm gate:phase2` builds the export, starts both servers and
 * runs this; running `playwright test` by hand needs the E2E_* variables it sets.
 *
 * Hard limits: 60 s per test, 10 minutes for the whole run. One worker, no retries, so a red is a red.
 */
export default defineConfig({
  testDir: './e2e',
  // An explicit registry of spec files: a spec that is not listed here does not run, and the gate fails if the
  // report does not hold exactly the tests in the gate's registry (acceptance.json for gate:phase2,
  // acceptance-phase3.json for gate:phase3). Each gate names its own spec on the command line.
  testMatch: ['exit-acceptance.spec.ts', 'phase3-acceptance.spec.ts', 'phase4-acceptance.spec.ts', 'gate-c.spec.ts'],
  timeout: 60_000,
  // Ten minutes for a gate's whole run unless the gate asks for longer (gate C walks the whole demo twice).
  globalTimeout: Number(process.env.E2E_SUITE_TIMEOUT_MS ?? 600_000),
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: 'disabled', caret: 'hide' } },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // Screenshot baselines are committed beside the spec, one per platform (`-chromium-darwin.png`). A missing baseline
  // fails the run instead of writing one; `E2E_UPDATE_SNAPSHOTS=1 pnpm gate:phase2` rewrites them on purpose.
  updateSnapshots: process.env.E2E_UPDATE_SNAPSHOTS === '1' ? 'all' : 'none',
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
