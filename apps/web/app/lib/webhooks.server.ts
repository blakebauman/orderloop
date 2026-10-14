/** Outbound webhook subscriptions. The engine's outbox (apps/engine/src/outbox.ts) delivers. */

import { newId } from '@orderloop/core';
import { webhookDeliveries, webhookSubscriptions } from '@orderloop/db';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { subscriptionInput } from './api-schemas';
import { db } from './env.server';

type Row = typeof webhookSubscriptions.$inferSelect;

const view = ({ secret: _secret, events, ...s }: Row) => ({
  ...s,
  events: JSON.parse(events) as string[],
});

export async function listSubscriptions() {
  const rows = await db()
    .select()
    .from(webhookSubscriptions)
    .orderBy(desc(webhookSubscriptions.createdAt))
    .limit(500);
  return rows.map(view);
}

/** The secret is returned once, here; afterwards only the receiver holds it. */
export async function createSubscription(input: z.infer<typeof subscriptionInput>) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const [row] = await db()
    .insert(webhookSubscriptions)
    .values({
      id: newId('whs'),
      url: input.url,
      secret,
      events: JSON.stringify(input.events),
      createdAt: Date.now(),
    })
    .returning();
  return { subscription: view(row!), secret };
}

export async function deleteSubscription(id: string) {
  const res = await db()
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .returning();
  return res.length > 0;
}

export async function listDeliveries(subscriptionId: string, limit = 50) {
  const rows = await db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
  return rows.map(({ payload, ...r }) => ({ ...r, payload: JSON.parse(payload) as unknown }));
}
