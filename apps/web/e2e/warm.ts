import { devices, type FullConfig, type Page, webkit } from '@playwright/test';
import { PAGES } from './helpers';

/**
 * Visits every page once before the tests. The first time the dev server sees a page's client
 * dependencies it bundles them and reloads the browser, which would interrupt whichever test got
 * there first. A reload can land in the middle of a step here too, so each one is retried.
 */
export default async function warm(config: FullConfig) {
  const base = config.projects[0]!.use.baseURL!;
  const browser = await webkit.launch();
  const page = await browser.newPage({ ...devices['iPhone 15'] });
  const attempt = async (step: (page: Page) => Promise<void>) => {
    for (let i = 0; ; i++) {
      try {
        return await step(page);
      } catch (err) {
        if (i === 3) throw err;
      }
    }
  };
  for (const path of PAGES) {
    await attempt((p) => p.goto(base + path, { waitUntil: 'networkidle' }).then(() => {}));
  }
  // The pieces that load on demand: an order's graph and the assistant.
  await attempt(async (p) => {
    const res = await p.goto(`${base}/orders/scenarios`, { waitUntil: 'networkidle' });
    try {
      await p.getByRole('button', { name: /^Run / }).first().click();
    } catch (err) {
      // CI once failed here on all four tries with only "waiting for getByRole(...)": say what
      // page this was (a 404, a redirect to login or an error boundary all look the same).
      const text = await p
        .locator('body')
        .innerText({ timeout: 2_000 })
        .catch(() => '(no body)');
      throw new Error(
        `no Run button at ${p.url()} (HTTP ${res?.status()}): ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
        { cause: err },
      );
    }
    await p.waitForURL(/\/orders\/ord_/, { timeout: 30_000 });
    await p.getByRole('tab', { name: 'Graph' }).click();
    await p.locator('.react-flow').waitFor({ timeout: 20_000 });
  });
  await attempt(async (p) => {
    await p.goto(`${base}/orders`, { waitUntil: 'networkidle' });
    await p.locator('header button[aria-pressed]').click();
    await p.locator('textarea[aria-label="Message the assistant"]').waitFor({ timeout: 20_000 });
  });
  await page.waitForLoadState('networkidle');
  await browser.close();
}
