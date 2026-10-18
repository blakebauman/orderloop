/** Outbound webhook subscriptions. The engine's outbox (apps/engine/src/outbox.ts) delivers. */

import { newId, ROTATION_GRACE_MS, secretContext } from '@orderloop/core';
import { webhookDeliveries, webhookSubscriptions } from '@orderloop/db';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { subscriptionInput } from './api-schemas';
import { sealSecret } from './data-key.server';
import { db } from './env.server';

type Row = typeof webhookSubscriptions.$inferSelect;

/** What the API shows: never a secret. */
const view = ({
  secret: _secret,
  previousSecret: _previous,
  previousExpiresAt,
  events,
  ...s
}: Row) => ({
  ...s,
  events: JSON.parse(events) as string[],
  /** When the previous secret stops signing deliveries, while a rotation is under way. */
  previousExpiresAt: previousExpiresAt && previousExpiresAt > Date.now() ? previousExpiresAt : null,
});

export async function listSubscriptions() {
  const rows = await db()
    .select()
    .from(webhookSubscriptions)
    .orderBy(desc(webhookSubscriptions.createdAt))
    .limit(500);
  return rows.map(view);
}

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The secret is returned once, here; afterwards only the receiver holds it. */
export async function createSubscription(input: z.infer<typeof subscriptionInput>) {
  const secret = newSecret();
  const id = newId('whs');
  const [row] = await db()
    .insert(webhookSubscriptions)
    .values({
      id,
      url: input.url,
      secret: await sealSecret(secret, secretContext.webhookSubscription(id)),
      events: JSON.stringify(input.events),
      createdAt: Date.now(),
    })
    .returning();
  return { subscription: view(row!), secret };
}

/**
 * A new signing secret, returned once. For `ROTATION_GRACE_MS` deliveries carry a signature from
 * the old secret too, so the receiver can switch without rejecting any. Null for an unknown id.
 */
export async function rotateSubscription(id: string) {
  const current = await db()
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .get();
  if (!current) return null;
  const secret = newSecret();
  const [row] = await db()
    .update(webhookSubscriptions)
    .set({
      secret: await sealSecret(secret, secretContext.webhookSubscription(id)),
      // Still sealed for this row: it moves across as it is.
      previousSecret: current.secret,
      previousExpiresAt: Date.now() + ROTATION_GRACE_MS,
    })
    .where(eq(webhookSubscriptions.id, id))
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
