import { expect, type Page, test } from '@playwright/test';
import { fakeSafeArea, isNarrow, isPhone, isTouch, open, PAGES, tapTargets } from './helpers';

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
    'header a, header button, nav[aria-label="Main"] a, nav[aria-label="Main"] button, [data-slot=sidebar] button[aria-label="Sidebar"], button[aria-label$="account menu"], main button',
  );
  expect(targets.length).toBeGreaterThan(0);
  // Height is what a thumb misses; a text link in a row can be as narrow as its word.
  expect(targets.filter((t) => t.height < 44)).toEqual([]);
});

test('fields are 16px on touch screens, so iOS does not zoom into them', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  for (const path of [
    '/orders',
    '/commerce',
    '/customers/cus_northwind',
    '/flows',
    '/orders/new',
  ]) {
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

test('at double text size the sidebar and header fit without scrolling sideways', async ({
  page,
}, info) => {
  test.skip(isPhone(info), 'phones have the tab bar');
  await open(page, '/orders');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const actions = [...document.querySelectorAll('header a, header button')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0);
        return {
          clipped: actions.some((r) => r.right > window.innerWidth + 0.5),
          sideways: document.documentElement.scrollWidth > window.innerWidth,
        };
      }),
    )
    .toEqual({ clipped: false, sideways: false });
});

/** The sidebar's width on screen: its panel, border included. */
const sidebarWidth = (page: Page) =>
  page
    .locator('#sidebar-nav')
    .evaluate((nav) =>
      Math.round(nav.closest('[data-slot=sidebar-container]')!.getBoundingClientRect().width),
    );

test('the sidebar holds every page, collapses to a rail and remembers it', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'the full sidebar is lg and up');
  await open(page, '/orders');
  const main = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Overview', 'Orders', 'Flows', 'Commerce', 'Catalog', 'Team and roles'])
    await expect(main.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Orders', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await sidebarWidth(page)).toBe(256);
  const toggle = page.getByRole('button', { name: 'Sidebar', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect.poll(() => sidebarWidth(page)).toBe(52);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // A rail keeps every page by name for screen readers.
  await expect(main.getByRole('link', { name: 'Commerce', exact: true })).toBeAttached();
  await open(page, '/orders');
  expect(await sidebarWidth(page), 'collapsed before paint after a reload').toBe(52);
  await page.locator('main h1').click();
  await page.keyboard.press('Meta+Backslash');
  await expect.poll(() => sidebarWidth(page)).toBe(256);
});

test('on a canvas the sidebar is a rail that opens over the page', async ({ page }, info) => {
  test.skip(isNarrow(info), 'the editor edits at lg');
  await open(page, '/flows/tpl-storefront-order');
  expect(await sidebarWidth(page)).toBe(52);
  const canvas = page.locator('main');
  const before = await canvas.boundingBox();
  await page.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await expect.poll(() => sidebarWidth(page)).toBe(256);
  expect((await canvas.boundingBox())!.x, 'the page stays where it was').toBe(before!.x);
  await page.keyboard.press('Escape');
  await expect.poll(() => sidebarWidth(page)).toBe(52);
});

test('an iPad upright has the rail beside the page', async ({ page }, info) => {
  test.skip(info.project.name !== 'ipad', 'iPad upright');
  await open(page, '/orders');
  expect(await sidebarWidth(page)).toBe(52);
  await page.getByRole('button', { name: 'Sidebar', exact: true }).tap();
  await expect.poll(() => sidebarWidth(page)).toBe(256);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Carts' }).tap();
  await expect(page).toHaveURL(/\/carts$/);
  await expect.poll(() => sidebarWidth(page)).toBe(52);
});
