/**
 * Outbound webhooks. `emit` records one delivery per matching subscription, keyed by the step that
 * emitted it, then attempts every delivery for that key that hasn't succeeded yet. It never throws:
 * the caller's step throws on `pending > 0` so Workflows retries with backoff, and the interpreter
 * swallows the final failure so a dead endpoint can't fail an order.
 */

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  type Order,
  type OutboundEvent,
  type OutboundPayload,
  SIGNATURE_HEADER,
  signWebhook,
  subscribedTo,
} from '@orderloop/core';
import { createDb, webhookDeliveries, webhookSubscriptions } from '@orderloop/db';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

const TIMEOUT_MS = 10_000;

export async function emit(
  env: Env,
  stepKey: string,
  orderId: string,
  event: OutboundEvent,
  data: Record<string, unknown>,
) {
  const d = createDb(env.DB);
  const subs = (
    await d.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.active, true))
  ).filter((s) => subscribedTo(parseEvents(s.events), event));
  if (!subs.length) return { delivered: 0, pending: 0 };

  const secrets = new Map(subs.map((s) => [s.id, s]));
  const ids = subs.map((s) => `whd_${orderId}_${stepKey}_${s.id}`.replace(/[^\w-]/g, '_'));
  const now = Date.now();
  const [first, ...rest] = subs.map((s, i) => {
    const payload: OutboundPayload = { id: ids[i]!, event, occurredAt: now, orderId, data };
    return d
      .insert(webhookDeliveries)
      .values({
        id: ids[i]!,
        subscriptionId: s.id,
        orderId,
        event,
        payload: JSON.stringify(payload),
        createdAt: now,
      })
      .onConflictDoNothing();
  });
  await d.batch([first!, ...rest]);

  const open = await d
    .select()
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.id, ids), ne(webhookDeliveries.status, 'delivered')));
  // Every subscriber at once: one slow receiver must not use up the step's time for the rest.
  const sent = await Promise.all(
    open.map(async (row) => {
      const sub = secrets.get(row.subscriptionId);
      if (!sub) return null;
      const res = await send(sub.url, sub.secret, row.id, row.event, row.payload);
      return { row, res };
    }),
  );
  const done = sent.filter((x) => x !== null);
  if (done.length) {
    const [u, ...us] = done.map(({ row, res }) =>
      d
        .update(webhookDeliveries)
        .set({
          status: res.ok ? 'delivered' : 'failed',
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          responseStatus: res.status,
          lastError: res.error,
          deliveredAt: res.ok ? Date.now() : null,
        })
        .where(eq(webhookDeliveries.id, row.id)),
    );
    await d.batch([u!, ...us]);
  }
  const pending = done.filter(({ res }) => !res.ok).length;
  return { delivered: ids.length - pending, pending };
}

async function send(url: string, secret: string, id: string, event: string, body: string) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: await signWebhook(secret, body),
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: id,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Drain so the connection is released.
    await res.body?.cancel();
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseEvents(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function orderSummary(o: Order) {
  return {
    id: o.id,
    model: o.model,
    channel: o.channel,
    externalId: o.externalId ?? null,
    title: o.title ?? null,
    customerId: o.customerId ?? null,
    currency: o.currency,
    subtotal: o.subtotal,
    shipping: o.shipping ?? 0,
    tax: o.tax,
    total: o.total,
    fxRate: o.fxRate ?? 1,
    baseTotal: o.baseTotal ?? o.total,
  };
}
