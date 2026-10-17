/**
 * Checkout sessions in data subject requests (../subjects.ts). A session holds its buyer's email,
 * name, phone and ship-to: exported with the rest of what is held about them, and erased with
 * their orders (a session that placed an order keeps its lines and totals for the order's events;
 * one that never did is deleted).
 */

import type { CheckoutSession } from '@orderloop/core';
import { checkoutSessions, createDb } from '@orderloop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

const byEmail = (email: string) =>
  sql`lower(json_extract(${checkoutSessions.data}, '$.buyer.email')) = ${email.toLowerCase()}`;

/** The sessions whose buyer is `email`, as stored. */
export async function checkoutsOf(env: Env, email: string): Promise<CheckoutSession[]> {
  const rows = await createDb(env.DB)
    .select({ data: checkoutSessions.data })
    .from(checkoutSessions)
    .where(byEmail(email))
    .limit(500);
  return rows.map((r) => JSON.parse(r.data) as CheckoutSession);
}

/** Removes the buyer from the sessions that placed `orderIds`. */
export async function scrubCheckouts(env: Env, orderIds: string[]) {
  if (!orderIds.length) return 0;
  const d = createDb(env.DB);
  const rows = await d
    .select({ id: checkoutSessions.id, data: checkoutSessions.data })
    .from(checkoutSessions)
    .where(inArray(checkoutSessions.orderId, orderIds));
  for (const r of rows) {
    const s = JSON.parse(r.data) as CheckoutSession;
    const scrubbed: CheckoutSession = { ...s, buyer: {}, shipTo: null, issues: [] };
    await d
      .update(checkoutSessions)
      .set({ data: JSON.stringify(scrubbed) })
      .where(eq(checkoutSessions.id, r.id));
  }
  return rows.length;
}

/** Deletes the sessions of `email` that never placed an order. */
export async function deleteCheckoutsOf(env: Env, email: string) {
  const res = await createDb(env.DB)
    .delete(checkoutSessions)
    .where(and(isNull(checkoutSessions.orderId), byEmail(email)))
    .returning({ id: checkoutSessions.id });
  return res.length;
}
