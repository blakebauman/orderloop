import { expect, test } from '@playwright/test';
import { open } from './helpers';

test('identical requests group, and a batch asks once, on one card in the assistant', async ({
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
  // One card in the assistant names the whole batch; nothing is decided until it is confirmed.
  await expect(group.getByText(/^Confirm approving \d+ approvals in the assistant$/)).toBeVisible();
  const card = page.getByRole('complementary', { name: 'Assistant' }).getByRole('region', {
    name: /^Approve \d+ approvals$/,
  });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(group.getByText('Left as they were. You declined.')).toBeAttached();
  await expect(group.getByRole('button', { name: /^Approve #/ }).first()).toBeEnabled();

  // X ticks the focused row, and only within its group.
  await group.getByRole('listitem').first().focus();
  await page.keyboard.press('x');
  await expect(group.getByText('1 selected')).toBeVisible();
});
