import { expect, test } from '@playwright/test';
import { isNarrow, open } from './helpers';

test('leaving unsaved edits asks in place; the safe choice has focus and Escape stays', async ({
  page,
}, info) => {
  test.skip(isNarrow(info), 'the editor edits at lg');
  await open(page, '/flows/tpl-storefront-order');
  const name = page.getByRole('textbox', { name: 'Flow name' });
  await name.fill('Storefront order, edited');
  await page.getByRole('link', { name: 'Flows', exact: true }).first().click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('unsaved changes');
  await expect(ask.getByRole('button', { name: 'Stay' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(page).toHaveURL(/\/flows\/tpl-storefront-order$/);
  await expect(name).toHaveValue('Storefront order, edited');
});

test('"/" goes to search, but not while a menu is open over the page', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a hardware keyboard');
  await open(page, '/orders');
  // An open menu hides the page from the accessibility tree, so find the field by name.
  const search = page.locator('input[name="q"]');
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('/');
  await expect(search).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.locator('main h1').click();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
});

test('Account offers the Home Screen on an iPhone or iPad, until dismissed', async ({
  page,
}, info) => {
  const hint = page.getByRole('complementary', { name: 'Add to Home Screen' });
  await open(page, '/account');
  if (info.project.name === 'desktop') {
    await expect(hint).toHaveCount(0);
    return;
  }
  await expect(hint).toBeVisible();
  await hint.getByRole('button', { name: 'Not now' }).click();
  await expect(hint).toHaveCount(0);
  await open(page, '/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await expect(hint).toHaveCount(0);
});
