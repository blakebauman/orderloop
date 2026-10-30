/**
 * The places a customer's orders ship to (`customer_addresses`), for the customer page. An order
 * adds its ship-to when it starts; orders started before the table are added by the daily sweep
 * (`backfillAddresses`); erasure and the personal data retention sweep remove them.
 */

import {
  erasedCustomerEmail,
  newId,
  type OrderState,
  personalDataRetentionDays,
  rememberedAddress,
} from '@orderloop/core';
import { createDb, customerAddresses, customers, type Db, orders } from '@orderloop/db';
import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { orderAgent } from './namespaces';

/**
 * Records the order's ship-to against its customer: a new place adds a row, a known one counts
 * the order and takes its recipient's name. Free text and unusable addresses aren't kept.
 */
export async function rememberAddress(
  db: Db,
  order: { id: string; customerId?: string | null; shipTo: unknown; at: number },
) {
  if (!order.customerId) return;
  const remembered = rememberedAddress(order.shipTo);
  if (!remembered) return;
  const { key, address: a } = remembered;
  await db
    .insert(customerAddresses)
    .values({
      id: newId('adr'),
      customerId: order.customerId,
      key,
      name: a.name ?? null,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      region: a.region ?? null,
      postalCode: a.postalCode,
      country: a.country,
      firstUsedAt: order.at,
      lastUsedAt: order.at,
      lastOrderId: order.id,
    })
    .onConflictDoUpdate({
      target: [customerAddresses.customerId, customerAddresses.key],
      // By date, not by write: the backfill counts orders older than those already counted.
      set: {
        name: sql`CASE WHEN excluded.last_used_at >= ${customerAddresses.lastUsedAt} THEN excluded.name ELSE ${customerAddresses.name} END`,
        orders: sql`${customerAddresses.orders} + 1`,
        firstUsedAt: sql`min(${customerAddresses.firstUsedAt}, excluded.first_used_at)`,
        lastUsedAt: sql`max(${customerAddresses.lastUsedAt}, excluded.last_used_at)`,
        lastOrderId: sql`CASE WHEN excluded.last_used_at >= ${customerAddresses.lastUsedAt} THEN excluded.last_order_id ELSE ${customerAddresses.lastOrderId} END`,
      },
    });
}

/** Marked orders one sweep reads; the rest wait for the next day's. */
const BACKFILL_MAX = 200;
const DAY = 86_400_000;

/**
 * Adds the ship-to of orders started before `customer_addresses` (marked `address_pending` by
 * migration 0063), read from each order's agent, dated when the order started, then clears the
 * mark. An erased order or customer adds nothing, nor does an order older than the personal data
 * retention, whose address that sweep would delete again. Returns how many orders it cleared;
 * once every mark is cleared this finds nothing.
 */
export async function backfillAddresses(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const due = await db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      createdAt: orders.createdAt,
      erasedAt: orders.erasedAt,
    })
    .from(orders)
    .where(isNotNull(orders.addressPending))
    .limit(BACKFILL_MAX);
  if (!due.length) return 0;
  const ids = [...new Set(due.flatMap((o) => (o.customerId ? [o.customerId] : [])))];
  const live = new Set(
    (
      await db
        .select({ id: customers.id, email: customers.email })
        .from(customers)
        .where(inArray(customers.id, ids))
    )
      .filter((c) => c.email !== erasedCustomerEmail(c.id))
      .map((c) => c.id),
  );
  const days = personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS);
  const cutoff = days === null ? -Infinity : now - days * DAY;
  let cleared = 0;
  for (const o of due) {
    try {
      if (o.customerId && live.has(o.customerId) && !o.erasedAt && o.createdAt >= cutoff) {
        const state = (await orderAgent(env, o.id).snapshot()) as OrderState;
        await rememberAddress(db, {
          id: o.id,
          customerId: o.customerId,
          shipTo: state.order?.meta?.shipTo,
          at: o.createdAt,
        });
      }
      await db.update(orders).set({ addressPending: null }).where(eq(orders.id, o.id));
      cleared++;
    } catch (e) {
      // One order that can't answer waits for the next sweep; the rest of the sweep goes on.
      console.error(
        JSON.stringify({ type: 'address_backfill_failed', id: o.id, error: String(e) }),
      );
    }
  }
  return cleared;
}
