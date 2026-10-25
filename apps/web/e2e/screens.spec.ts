import { expect, test } from '@playwright/test';
import { installKeyboard, isNarrow, keyboard, open } from './helpers';

test('below lg the flow editor is review-only', async ({ page }, info) => {
  test.skip(!isNarrow(info), 'below lg');
  await open(page, '/flows/tpl-storefront-order');
  await expect(page.getByText('Building flows needs a wider screen')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Publish/ })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Flow name' })).toHaveAttribute('readonly', '');
  // Picking a step shows its settings, with nothing to change them.
  await page.locator('.react-flow__node').first().tap();
  await expect(page.getByRole('button', { name: 'Delete node' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node.draggable')).toHaveCount(0);
  await expect(page.getByText('Unsaved')).toHaveCount(0);
});

test('at lg the flow editor edits', async ({ page }, info) => {
  test.skip(isNarrow(info), 'lg and up');
  await open(page, '/flows/tpl-storefront-order');
  await expect(page.getByRole('button', { name: /^Publish/ })).toBeVisible();
  await page.locator('.react-flow__node').first().click();
  await expect(page.getByRole('button', { name: 'Delete node' })).toBeVisible();
});

test('below lg the order page shows one view at a time', async ({ page }, info) => {
  test.skip(!isNarrow(info), 'below lg');
  await open(page, '/orders/scenarios');
  await page.getByRole('button', { name: /^Run / }).first().click();
  await expect(page).toHaveURL(/\/orders\/ord_/, { timeout: 30_000 });
  const tabs = page.getByRole('tablist', { name: 'Order panels' });
  const graph = tabs.getByRole('tab', { name: 'Graph' });
  await expect(graph).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  // A running order that starts waiting on a decision switches to Actions by itself, so keep
  // choosing Graph until the order settles.
  await expect(async () => {
    await graph.click();
    await expect(graph).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});

test('the assistant composer stays above the on-screen keyboard', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone', 'iPhone upright');
  await installKeyboard(page);
  await open(page, '/orders');
  await page.locator('header button[aria-pressed]').tap();
  const box = page.locator('textarea[aria-label="Message the assistant"]');
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.tap();
  const visible = Math.round(page.viewportSize()!.height * 0.5);
  await keyboard(page, visible);
  await expect(page.locator('html[data-keyboard]')).toBeAttached();
  const composer = await box.boundingBox();
  expect(composer!.y).toBeGreaterThanOrEqual(0);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(visible);
  // Return is a new line on a touch screen; the button sends.
  await box.pressSequentially('one');
  await page.keyboard.press('Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('one\ntwo');
  await keyboard(page, null);
  await expect(page.locator('html[data-keyboard]')).toHaveCount(0);
});
