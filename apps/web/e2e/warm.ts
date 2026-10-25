import { devices, type FullConfig, webkit } from '@playwright/test';
import { PAGES } from './helpers';

/**
 * Visits every page once before the tests. The first time the dev server sees a page's client
 * dependencies it bundles them and reloads the browser, which would interrupt whichever test got
 * there first.
 */
export default async function warm(config: FullConfig) {
  const base = config.projects[0]!.use.baseURL!;
  const browser = await webkit.launch();
  const page = await browser.newPage({ ...devices['iPhone 15'] });
  for (const path of [...PAGES, '/orders/scenarios']) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
  }
  // The pieces that load on demand: an order's graph and the assistant.
  await page.getByRole('button', { name: /^Run / }).first().click();
  await page.waitForURL(/\/orders\/ord_/, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Graph' }).click();
  await page.locator('.react-flow').waitFor({ timeout: 60_000 });
  await page.locator('header button[aria-pressed]').click();
  await page.locator('textarea[aria-label="Message the assistant"]').waitFor({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  await browser.close();
}
