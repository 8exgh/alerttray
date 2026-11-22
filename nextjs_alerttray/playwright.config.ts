import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the PWA: real Next.js server (production build), real
 * background processor, and a local HTTPS stand-in for the push service.
 * Run with `npm run test:e2e` (builds first).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // Full Chromium (new headless), not the headless shell: the shell always
    // denies notification permission, so service-worker notifications cannot be checked.
    channel: 'chromium',
    trace: 'retain-on-failure'
  }
});
