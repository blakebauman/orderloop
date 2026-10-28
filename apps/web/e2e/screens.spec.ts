import { expect, test } from '@playwright/test';
import { installKeyboard, isNarrow, isTouch, keyboard, open, tapTargets } from './helpers';

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

test("a loop's next input is drawn in ink and named, not in a status colour", async ({
  page,
}, info) => {
  test.skip(isNarrow(info), 'lg and up');
  await open(page, '/flows/tpl-marketplace-order');
  const node = page.locator('.react-flow__node', { has: page.locator('[data-handleid="next"]') });
  await expect(node).toHaveCount(1);
  await expect(node.getByText('next', { exact: true })).toBeAttached();
  const colours = await node.locator('[data-handleid="next"]').evaluate((handle) => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--wait)';
    document.body.appendChild(probe);
    const wait = getComputedStyle(probe).color;
    probe.remove();
    const h = getComputedStyle(handle);
    return { wait, fill: h.backgroundColor, ring: h.borderTopColor };
  });
  expect(colours.fill).not.toBe(colours.wait);
  expect(colours.ring).not.toBe(colours.wait);
});

test('on a phone the overview puts the decision first, clear of New order', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'iphone', 'iPhone upright');
  await open(page, '/');
  const decision = page
    .getByRole('heading', { name: /Needs a decision/ })
    .or(page.getByText('No decisions waiting.'));
  const strip = page.getByRole('heading', { name: 'Open now' });
  const [d, s] = [await decision.boundingBox(), await strip.boundingBox()];
  expect(d!.y, 'the decision comes before the status strip').toBeLessThan(s!.y);
  // The status strip is a line per group on a phone, not a block of tiles.
  const figures = page.getByRole('navigation', { name: 'Orders by status' }).getByRole('link');
  const heights = await figures.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height),
  );
  expect(Math.max(...heights)).toBeLessThanOrEqual(48);
  const fab = await page.getByRole('link', { name: 'New order' }).last().boundingBox();
  expect(d!.y + d!.height, 'the decision heading is above the New order button').toBeLessThan(
    fab!.y,
  );
});

test('on a phone the orders list keeps search and puts the filters in a sheet', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'iphone', 'iPhone upright');
  await open(page, '/orders');
  const search = page.getByRole('searchbox', { name: /Search orders/ });
  await expect(search).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status' })).toBeHidden();
  await page.getByRole('button', { name: /^Filter/ }).tap();
  const sheet = page.getByRole('dialog', { name: 'Filter orders' });
  await sheet.getByLabel('Status').selectOption('failed');
  await expect(page).toHaveURL(/[?&]status=failed/);
  await sheet.getByRole('button', { name: 'Done' }).tap();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: /^Filter/ })).toHaveText(/1 on/);
  // A search after that keeps the filter set in the sheet.
  await search.fill('ord');
  await expect(page).toHaveURL(/[?&]q=ord/);
  expect(new URL(page.url()).searchParams.get('status')).toBe('failed');
});

test('below lg the order page shows one view at a time', async ({ page }, info) => {
  test.skip(!isNarrow(info), 'below lg');
  // Starting a real order, then waiting for it to settle: slower on a CI runner.
  test.setTimeout(60_000);
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
  }).toPass({ timeout: 40_000 });
});

test('on an iPhone a long-titled order fits the screen, and Cancel order is in the ⋯ menu', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'iphone', 'iPhone upright');
  test.setTimeout(60_000);
  await open(page, '/orders/scenarios');
  // A purchase request waits on approvals, so it stays cancellable while the test looks.
  await page.getByRole('button', { name: 'Run Purchase request' }).click();
  await expect(page).toHaveURL(/\/orders\/ord_/, { timeout: 30_000 });
  const title = page.locator('h1').first();
  await expect(title).toContainText('Laptops for the new support team');
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  // The title wraps rather than truncating: nothing of it is cut off.
  const cut = await title
    .locator('span')
    .first()
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(cut).toBe(false);
  await expect(page.getByRole('button', { name: 'Cancel order' })).toBeHidden();
  await page.getByRole('button', { name: 'More order actions' }).tap();
  await page.getByRole('menuitem', { name: 'Cancel order…' }).tap();
  // The same inline confirmation as the desktop's button, with its reason field focused.
  await expect(page.getByText('Cancel this order?')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  await page.getByRole('button', { name: 'Keep order' }).tap();
  await expect(page.getByText('Cancel this order?')).toHaveCount(0);
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

test('a cart finds a product by name and adds it with a quantity', async ({ page }, info) => {
  await open(page, '/carts');
  await page.getByRole('button', { name: 'New cart' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Search check');
  await page.getByRole('dialog').getByRole('button', { name: 'Open cart' }).click();
  await expect(page).toHaveURL(/\/carts\/cart_/);
  await open(page, new URL(page.url()).pathname);
  const find = page.getByRole('searchbox', { name: 'Find a product' });
  await find.fill('widget');
  const results = page.getByRole('list', { name: 'Products found' });
  const row = results.getByRole('listitem').filter({ hasText: 'WID-100' });
  await expect(row).toBeVisible();
  await row.getByRole('textbox', { name: 'Quantity of WID-100 to add' }).fill('3');
  await row.getByRole('button', { name: 'Add WID-100' }).click();
  // The cart's own line, with the quantity it was added with.
  await expect(page.getByRole('textbox', { name: 'Quantity of WID-100', exact: true })).toHaveValue(
    '3',
  );
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  if (!isTouch(info)) return;
  // The search, each quantity and each Add work for a thumb, and iOS doesn't zoom into them.
  const size = await find.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
  const adds = await tapTargets(page, '[aria-label="Products found"] button');
  expect(adds.length).toBeGreaterThan(0);
  expect(adds.filter((t) => t.height < 44)).toEqual([]);
});

test('a cart sets the quantity of several lines at once, and removes them', async ({
  page,
}, info) => {
  await open(page, '/carts');
  await page.getByRole('button', { name: 'New cart' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Bulk check');
  await page.getByRole('dialog').getByRole('button', { name: 'Open cart' }).click();
  await expect(page).toHaveURL(/\/carts\/cart_/);
  await open(page, new URL(page.url()).pathname);
  for (const sku of ['WID-100', 'GSK-010']) {
    await page.getByLabel('Or add by SKU').fill(sku);
    await page.getByRole('button', { name: 'Add line' }).click();
    await expect(
      page.getByRole('textbox', { name: `Quantity of ${sku}`, exact: true }),
    ).toHaveValue('1');
    // The form empties once the add is answered, which can be after the line shows.
    await expect(page.getByLabel('Or add by SKU')).toHaveValue('');
  }
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await expect(page.getByText('2 of 2 selected')).toBeVisible();
  await page.getByRole('textbox', { name: 'Quantity for the selected lines' }).fill('5');
  await page.getByRole('button', { name: 'Set quantity' }).click();
  for (const sku of ['WID-100', 'GSK-010'])
    await expect(
      page.getByRole('textbox', { name: `Quantity of ${sku}`, exact: true }),
    ).toHaveValue('5');
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  if (isTouch(info)) {
    // Each checkbox and the bulk controls work for a thumb, and iOS doesn't zoom into the field.
    const boxes = await tapTargets(page, 'label.hit-area:has(input[type="checkbox"])');
    expect(boxes.length).toBe(3);
    expect(boxes.filter((t) => t.height < 44 || t.width < 44)).toEqual([]);
    const qty = page.getByRole('textbox', { name: 'Quantity for the selected lines' });
    const size = await qty.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
    const bulk = await tapTargets(page, '[aria-label="Selected lines"] button');
    expect(bulk.map((t) => t.name)).toEqual(['Set quantity', 'Remove 2 lines']);
    expect(bulk.filter((t) => t.height < 44)).toEqual([]);
  }
  const bulkQty = page.getByRole('textbox', { name: 'Quantity for the selected lines' });
  // 0 takes the lines off, and the button says so.
  await bulkQty.fill('0');
  await expect(page.getByRole('button', { name: 'Set 0, removing 2 lines' })).toBeVisible();
  await bulkQty.fill('');

  // A ticked line removed and added again (it takes the same id) comes back unticked, and Set
  // quantity refuses rather than setting only the lines that are left.
  await page.getByRole('button', { name: 'Remove GSK-010' }).click();
  await expect(page.getByText('A line you chose is gone')).toBeVisible();
  await page.getByLabel('Or add by SKU').fill('GSK-010');
  await page.getByRole('button', { name: 'Add line' }).click();
  await expect(page.getByRole('textbox', { name: 'Quantity of GSK-010', exact: true })).toHaveValue(
    '1',
  );
  await expect(page.getByLabel('Or add by SKU')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Select GSK-010' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select WID-100' })).toBeChecked();
  await expect(page.getByText('1 of 2 selected')).toBeVisible();
  await bulkQty.fill('7');
  await page.getByRole('button', { name: 'Set quantity' }).click();
  await expect(page.getByRole('alert')).toHaveText('A line you chose is gone.');
  await expect(page.getByRole('textbox', { name: 'Quantity of WID-100', exact: true })).toHaveValue(
    '5',
  );

  // Told once; the choice as it stands now goes through.
  await page.getByRole('button', { name: 'Remove line', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Quantity of WID-100', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('textbox', { name: 'Quantity of GSK-010', exact: true })).toHaveValue(
    '1',
  );
});
