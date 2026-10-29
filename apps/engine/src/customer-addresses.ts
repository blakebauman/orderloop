/**
 * The places a customer's orders ship to (`customer_addresses`), for the customer page. An order
 * adds its ship-to when it starts; erasure and the personal data retention sweep remove them.
 */

import { newId, rememberedAddress } from '@orderloop/core';
import { customerAddresses, type Db } from '@orderloop/db';
import { sql } from 'drizzle-orm';

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
      set: {
        name: a.name ?? null,
        orders: sql`${customerAddresses.orders} + 1`,
        lastUsedAt: order.at,
        lastOrderId: order.id,
      },
    });
}
