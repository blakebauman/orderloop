import { expect, test } from '@playwright/test';
import { fakeSafeArea, isPhone, isTouch, open, PAGES, tapTargets } from './helpers';

for (const path of PAGES) {
  test(`${path} doesn't scroll sideways`, async ({ page }) => {
    await open(page, path);
    await expect(page.locator('h1').first()).toBeAttached();
    const [scroll, width] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  });
}

test('phones get the tab bar, clear of the status bar and home indicator', async ({
  page,
}, info) => {
  test.skip(!isPhone(info), 'phones only');
  await open(page, '/');
  await fakeSafeArea(page);
  const bar = page.getByRole('navigation', { name: 'Main' });
  const orders = bar.getByRole('link', { name: 'Orders' });
  await expect(orders).toBeVisible();
  const tab = await orders.boundingBox();
  expect(tab!.y + tab!.height, 'a tab sits above the 34px home indicator').toBeLessThanOrEqual(
    page.viewportSize()!.height - 34,
  );
  const mark = await page.getByRole('link', { name: 'OrderLoop overview' }).boundingBox();
  expect(mark!.y, 'the top bar sits below the 47px status bar').toBeGreaterThanOrEqual(47);
});

test('More holds the other pages and closes on navigation', async ({ page }, info) => {
  test.skip(!isPhone(info), 'phones only');
  await open(page, '/');
  await page.getByRole('button', { name: 'More' }).tap();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('link', { name: 'Commerce' }).tap();
  await expect(page).toHaveURL(/\/commerce$/);
  await expect(sheet).toBeHidden();
  // The route announcer says where the navigation landed.
  await expect(page.locator('p[aria-live="polite"][aria-atomic="true"]')).toHaveText('Commerce');
});

test('controls take a 44px tap on touch screens', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  await open(page, '/orders');
  const targets = await tapTargets(
    page,
    'header a, header button, nav[aria-label="Main"] a, nav[aria-label="Main"] button, main button',
  );
  expect(targets.length).toBeGreaterThan(0);
  // Height is what a thumb misses; a text link in a row can be as narrow as its word.
  expect(targets.filter((t) => t.height < 44)).toEqual([]);
});

test('fields are 16px on touch screens, so iOS does not zoom into them', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  for (const path of ['/orders', '/commerce', '/flows', '/orders/new']) {
    await open(page, path);
    await expect(page.locator('h1').first()).toBeAttached();
    const small = await page.$$eval(
      'input:not([type=hidden], [type=checkbox], [type=radio]), textarea, select',
      (els) =>
        els
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => ({
            field: el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.tagName,
            size: Number.parseFloat(getComputedStyle(el).fontSize),
          }))
          .filter((f) => f.size < 16),
    );
    expect(small, path).toEqual([]);
  }
});

test('at double text size the top bar folds links into More rather than overlapping', async ({
  page,
}, info) => {
  test.skip(isPhone(info), 'phones have the tab bar');
  await open(page, '/orders');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const more = page.locator('header nav > button');
  await expect(more).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = document.querySelector('header nav > button')!.getBoundingClientRect();
        const actions = [...document.querySelectorAll('header > div > div:last-child > *')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0);
        const overlaps = actions.some((r) => r.left < box.right - 0.5);
        return { overlaps, sideways: document.documentElement.scrollWidth > window.innerWidth };
      }),
    )
    .toEqual({ overlaps: false, sideways: false });
});
