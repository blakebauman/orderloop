import { defineConfig, devices } from '@playwright/test';

/**
 * `E2E_PORT` moves the dev server off 5390, so device tests in another worktree can run at the
 * same time. A server already on the port is reused only with `E2E_REUSE=1`: otherwise the run
 * would quietly test whatever another checkout is serving there, and `--strictPort` stops it instead.
 */
const PORT = Number(process.env.E2E_PORT ?? 5390);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error(
    `E2E_PORT must be a port number from 1024 to 65535, not "${process.env.E2E_PORT}"`,
  );
const state = '.wrangler/e2e';

/**
 * Device tests: the web app in WebKit on an iPhone and an iPad, both ways up, plus a desktop, against
 * the dev server running offline (ORDERLOOP_E2E in vite.config.ts) on a fresh database with the demo
 * seed. They check what unit tests can't: layout at each size, the safe areas, touch targets and the
 * on-screen keyboard. See docs/testing.md.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/warm.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // On CI, one test at a time and two retries: the runner is small, and the dev server's Workers
  // runtime (with the orders the tests start still running in it) has crashed under two at once.
  // Locally, in parallel, it still crashes now and then; `open()` rides that out on a page load,
  // but a test caught mid-action (a form submit) fails, so it gets one retry, reported as flaky.
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'iphone-landscape', use: { ...devices['iPhone 15 landscape'] } },
    { name: 'ipad', use: { ...devices['iPad (gen 7)'] } },
    { name: 'ipad-landscape', use: { ...devices['iPad Pro 11 landscape'] } },
    { name: 'desktop', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: [
      `rm -rf ${state}`,
      `wrangler d1 migrations apply orderloop --local --persist-to ${state}`,
      `wrangler d1 execute orderloop --local --persist-to ${state} --file ../../packages/db/seed/0001_demo.sql`,
      `ORDERLOOP_E2E=1 react-router dev --port ${PORT} --strictPort`,
    ].join(' && '),
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI && process.env.E2E_REUSE === '1',
    timeout: 180_000,
    stdout: 'ignore',
  },
});
