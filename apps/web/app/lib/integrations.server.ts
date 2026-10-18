/**
 * Integrations: the external systems that sign webhooks, each with its own secret and scope
 * (`IntegrationScope` and the checks in @orderloop/core). Created, rotated and revoked through
 * `/api/v1/integrations`; a signed request names its integration with `k=` in the signature.
 */

import {
  type IntegrationScope,
  newId,
  newWebhookSecret,
  type OrderChannel,
  ROTATION_GRACE_MS,
  secretContext,
} from '@orderloop/core';
import { integrations, orders } from '@orderloop/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { integrationInput } from './api-schemas';
import { openSecret, sealSecret } from './data-key.server';
import { db } from './env.server';

type Row = typeof integrations.$inferSelect;

export type Integration = IntegrationScope & {
  id: string;
  name: string;
  secret: string;
  previousSecret: string | null;
  previousExpiresAt: number | null;
};

const scope = (r: Row): IntegrationScope => ({
  events: JSON.parse(r.events) as string[],
  startOrders: r.startOrders,
  flows: JSON.parse(r.flows) as string[],
  channel: (r.channel as OrderChannel | null) ?? null,
});

/** What the API shows: never a secret. */
const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  ...scope(r),
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  /** When the previous secret stops working, while a rotation is under way. */
  previousExpiresAt:
    r.previousExpiresAt && r.previousExpiresAt > Date.now() ? r.previousExpiresAt : null,
});

export async function listIntegrations() {
  const rows = await db()
    .select()
    .from(integrations)
    .orderBy(desc(integrations.createdAt))
    .limit(500);
  return rows.map(view);
}

/** The secret is returned once, here; afterwards only the sender holds it. */
export async function createIntegration(input: z.infer<typeof integrationInput>, by: string) {
  const secret = newWebhookSecret();
  const id = newId('int');
  const [row] = await db()
    .insert(integrations)
    .values({
      id,
      name: input.name,
      secret: await sealSecret(secret, secretContext.integration(id)),
      events: JSON.stringify(input.events),
      startOrders: input.startOrders,
      flows: JSON.stringify(input.flows),
      channel: input.channel ?? null,
      createdAt: Date.now(),
      createdBy: by,
    })
    .returning();
  return { integration: view(row!), secret };
}

/**
 * A new secret; the current one keeps working for `ROTATION_GRACE_MS`, so the sender can switch
 * without a gap. Null for an unknown or revoked integration.
 */
export async function rotateIntegration(id: string) {
  const current = await active(id);
  if (!current) return null;
  const secret = newWebhookSecret();
  const [row] = await db()
    .update(integrations)
    .set({
      secret: await sealSecret(secret, secretContext.integration(id)),
      // Still sealed for this row: it moves across as it is.
      previousSecret: current.secret,
      previousExpiresAt: Date.now() + ROTATION_GRACE_MS,
    })
    .where(eq(integrations.id, id))
    .returning();
  return { integration: view(row!), secret };
}

/** Revoked at once, both secrets. The row stays for the audit log. */
export async function revokeIntegration(id: string) {
  const res = await db()
    .update(integrations)
    .set({ revokedAt: Date.now(), previousSecret: null, previousExpiresAt: null })
    .where(and(eq(integrations.id, id), isNull(integrations.revokedAt)))
    .returning();
  return res[0] ? view(res[0]) : null;
}

async function active(id: string) {
  return db()
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), isNull(integrations.revokedAt)))
    .get();
}

/** The integration a signature names, with its secrets, if it exists and isn't revoked. */
export async function findIntegration(id: string): Promise<Integration | null> {
  const r = await active(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    secret: await openSecret(r.secret, secretContext.integration(r.id)),
    previousSecret:
      r.previousSecret && (await openSecret(r.previousSecret, secretContext.integration(r.id))),
    previousExpiresAt: r.previousExpiresAt,
    ...scope(r),
  };
}

export async function touchIntegration(id: string) {
  await db().update(integrations).set({ lastUsedAt: Date.now() }).where(eq(integrations.id, id));
}

/** The channel of an order, for a channel-bound integration's events. Null when there's no such order. */
export async function orderChannel(orderId: string): Promise<string | null> {
  const r = await db()
    .select({ channel: orders.channel })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();
  return r?.channel ?? null;
}
