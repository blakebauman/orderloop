import { defineConfig, devices } from '@playwright/test';

const PORT = 5390;
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
  retries: process.env.CI ? 1 : 0,
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
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
  },
});
