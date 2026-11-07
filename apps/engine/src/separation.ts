/**
 * Separation of duties on approvals: with the workspace's `approval_separation` setting on, the
 * principal who started an order may not decide its approvals (`ownOrderRefusal` in core). The
 * OrderAgent checks it on every decision; the RPC and the assistant check first, to answer in
 * their own terms. It also holds a claim with nothing to send back (`planReturn` in the assistant),
 * which refunds at once with no goods to check.
 */

import { APPROVAL_SEPARATION_KEY, ownOrderRefusal } from '@orderloop/core';
import { createDb, orders, workspaceSettings } from '@orderloop/db';
import { eq } from 'drizzle-orm';

/** Why `deciderId` may not decide approvals on `orderId`, or null. */
export async function separationRefusal(
  env: Env,
  orderId: string,
  deciderId: string | undefined,
): Promise<string | null> {
  if (!deciderId) return null;
  const db = createDb(env.DB);
  const [setting, order] = await Promise.all([
    db
      .select({ value: workspaceSettings.value })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY))
      .get(),
    db.select({ startedBy: orders.startedBy }).from(orders).where(eq(orders.id, orderId)).get(),
  ]);
  return ownOrderRefusal(setting?.value === 'on', order?.startedBy, deciderId);
}
