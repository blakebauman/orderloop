import { expect, type Page, test } from '@playwright/test';
import { inView, isTouch, open } from './helpers';

const step = (page: Page, label: string) =>
  page.locator('.react-flow__node', { hasText: label }).first();

/** The canvas's zoom, from React Flow's viewport transform. */
const zoom = (page: Page) =>
  page
    .locator('.react-flow__viewport')
    .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);

test('the editor opens a flow where its orders loop, and Jump to reaches each wait', async ({
  page,
}, info) => {
  await open(page, '/flows/tpl-subscription');
  await expect.poll(() => inView(page, step(page, 'Billing periods'))).toBe(true);
  expect(await zoom(page)).toBeGreaterThanOrEqual(0.7);

  await page.getByRole('button', { name: 'Jump to' }).click();
  const item = page.getByRole('menuitem', { name: /Dunning delay/ });
  if (isTouch(info)) await item.tap();
  else await item.click();
  await expect.poll(() => inView(page, step(page, 'Dunning delay'))).toBe(true);

  // From the keyboard too.
  await page.getByRole('button', { name: 'Jump to' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: /Billing periods/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => inView(page, step(page, 'Billing periods'))).toBe(true);
});

test('Fit view keeps a wide flow’s labels readable', async ({ page }) => {
  await open(page, '/flows/tpl-subscription');
  await page.getByRole('button', { name: 'Fit view' }).click();
  // Labels are 13px; the floor keeps them at 10px or more.
  await expect.poll(() => zoom(page)).toBeGreaterThanOrEqual(10 / 13 - 0.001);
});
