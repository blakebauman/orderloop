import { expect, test } from '@playwright/test';
import { open } from './helpers';

test('identical requests group, and a batch holds each decision with one Undo all', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'a hardware keyboard');
  // Starting two real orders and waiting for both to reach their approval.
  test.setTimeout(90_000);
  for (let i = 0; i < 2; i++) {
    await open(page, '/orders/scenarios');
    await page.getByRole('button', { name: 'Run Purchase request', exact: true }).click();
    await expect(page).toHaveURL(/\/orders\/ord_/, { timeout: 30_000 });
  }
  // Other tests may add to the group; what matters is that it holds at least these two.
  const group = page.getByRole('region', { name: /^Manager approval · Purchase request/ });
  await expect(async () => {
    await open(page, '/approvals');
    expect(await group.getByRole('listitem').count()).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 40_000 });
  // The rule is said once, on the group, so rows show only what differs.
  await expect(group.getByRole('heading', { level: 2 })).toContainText(
    'Over the $5,000.00 threshold',
  );

  await group.getByRole('checkbox', { name: /^Select all in this group/ }).check();
  await group.getByRole('button', { name: 'Approve selected' }).click();
  // Each selected row holds its own decision, with its own Undo; the batch takes focus.
  const undoAll = group.getByRole('button', { name: 'Undo all' });
  await expect(undoAll).toBeFocused();
  expect(
    await group.getByRole('button', { name: 'Undo', exact: true }).count(),
  ).toBeGreaterThanOrEqual(2);

  // Z takes the whole batch back before anything is sent.
  await page.keyboard.press('z');
  await expect(undoAll).toHaveCount(0);
  await expect(group.getByText(/^Took back \d+; nothing was sent\.$/)).toBeAttached();
  await expect(group.getByRole('button', { name: /^Approve #/ }).first()).toBeEnabled();
  await expect(group.getByRole('heading', { level: 2 })).toBeFocused();

  // X ticks the focused row, and only within its group.
  await group.getByRole('listitem').first().focus();
  await page.keyboard.press('x');
  await expect(group.getByText('1 selected')).toBeVisible();
});
