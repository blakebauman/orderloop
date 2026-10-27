/**
 * Outbound webhooks. `emit` records one delivery per matching subscription, keyed by the step that
 * emitted it, then attempts every delivery for that key that hasn't succeeded yet. `emitCart` does
 * the same for a cart's events, keyed by the cart and the event (each happens once per cart). Installed
 * plugins that subscribe to the event get a delivery too (subscription id `plugin:<id>`), sent
 * over their binding instead of HTTP, with the same ids and retries. It never throws:
 * the caller's step throws on `pending > 0` so Workflows retries with backoff, and the interpreter
 * swallows the final failure so a dead endpoint can't fail an order.
 */

import {
  type CartEvent,
  type CartSummary,
  DELIVERY_HEADER,
  EVENT_HEADER,
  type Order,
  type OrderEvent,
  type OutboundEvent,
  type OutboundPayload,
  SIGNATURE_HEADER,
  safeFetch,
  secretContext,
  signWebhook,
  subscribedTo,
} from '@orderloop/core';
import { createDb, webhookDeliveries, webhookSubscriptions } from '@orderloop/db';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { openSecret } from './data-key';
import { installedPlugins } from './plugin-host';
import { deliverToPlugin, hasPlugins, manifests } from './plugins';

const TIMEOUT_MS = 10_000;
/** The subscription id of a plugin's deliveries: `plugin:<id>`. */
export const PLUGIN_SUBSCRIPTION = 'plugin:';

export function emit(
  env: Env,
  stepKey: string,
  orderId: string,
  event: OrderEvent,
  data: Record<string, unknown>,
) {
  return record(env, stepKey, orderId, event, (id, occurredAt) => ({
    id,
    event,
    occurredAt,
    orderId,
    data,
  }));
}

/**
 * A cart's event, with the cart as it was then (`cartSummary`: nothing that names the buyer). Its
 * deliveries are recorded under the cart's id where an order's go under the order's
 * (`webhook_deliveries.order_id`), keyed by the event, so a retried emit delivers once.
 */
export function emitCart(env: Env, cart: CartSummary, event: CartEvent) {
  return record(env, event, cart.id, event, (id, occurredAt) => ({
    id,
    event,
    occurredAt,
    cartId: cart.id,
    orderId: cart.orderId,
    data: { cart },
  }));
}

/**
 * Records and attempts the deliveries of one event. `subject` is the order (or cart) it is about,
 * which with `stepKey` and the subscription makes each delivery's id.
 */
async function record(
  env: Env,
  stepKey: string,
  subject: string,
  event: OutboundEvent,
  payloadOf: (id: string, occurredAt: number) => OutboundPayload,
) {
  const d = createDb(env.DB);
  const subs = (
    await d.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.active, true))
  ).filter((s) => subscribedTo(parseEvents(s.events), event));
  const plugins = (await manifests(env))
    .filter((m) => subscribedTo(m.events, event))
    .map((m) => ({ id: `${PLUGIN_SUBSCRIPTION}${m.id}` }));
  const targets = [...subs, ...plugins];
  if (!targets.length && !(await hasPlugins(env))) return { delivered: 0, pending: 0 };

  const secrets = new Map(subs.map((s) => [s.id, s]));
  const ids = targets.map((s) => `whd_${subject}_${stepKey}_${s.id}`.replace(/[^\w-]/g, '_'));
  const now = Date.now();
  const inserts = targets.map((s, i) => {
    const payload = payloadOf(ids[i]!, now);
    return d
      .insert(webhookDeliveries)
      .values({
        id: ids[i]!,
        subscriptionId: s.id,
        orderId: subject,
        event,
        payload: JSON.stringify(payload),
        createdAt: now,
      })
      .onConflictDoNothing();
  });
  const [first, ...rest] = inserts;
  if (first) await d.batch([first, ...rest]);

  // Also any plugin delivery recorded for this step by an earlier attempt, though the plugin isn't
  // among the targets now (it didn't answer this time): it stays pending until it's delivered.
  const earlier = `${`whd_${subject}_${stepKey}_`.replace(/[^\w-]/g, '_').replace(/[\\%_]/g, '\\$&')}%`;
  const open = await d
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        ne(webhookDeliveries.status, 'delivered'),
        or(
          inArray(webhookDeliveries.id, ids),
          and(
            eq(webhookDeliveries.orderId, subject),
            sql`${webhookDeliveries.id} LIKE ${earlier} ESCAPE '\\'`,
            sql`${webhookDeliveries.subscriptionId} LIKE 'plugin:%'`,
          ),
        ),
      ),
    );
  const deliver = async (row: (typeof open)[number]) => {
    if (row.subscriptionId.startsWith(PLUGIN_SUBSCRIPTION)) {
      const id = row.subscriptionId.slice(PLUGIN_SUBSCRIPTION.length);
      const res = await deliverToPlugin(env, id, JSON.parse(row.payload) as OutboundPayload);
      return { row, res };
    }
    const sub = secrets.get(row.subscriptionId);
    if (!sub) return null;
    const res = await send(env, sub, row.id, row.event, row.payload);
    return { row, res };
  };
  // Sandboxed plugins one delivery at a time (Worker Loader limits how many Dynamic Workers one
  // request has in flight); every other subscriber at once, so one slow receiver must not use up
  // the step's time for the rest.
  const sandboxed = new Set(
    (await installedPlugins(env)).flatMap((p) => (p.runtime === 'sandboxed' ? [p.id] : [])),
  );
  const isSandboxed = (row: (typeof open)[number]) =>
    row.subscriptionId.startsWith(PLUGIN_SUBSCRIPTION) &&
    sandboxed.has(row.subscriptionId.slice(PLUGIN_SUBSCRIPTION.length));
  const [sent, inTurn] = await Promise.all([
    Promise.all(open.filter((r) => !isSandboxed(r)).map(deliver)),
    (async () => {
      const out = [];
      for (const row of open.filter(isSandboxed)) out.push(await deliver(row));
      return out;
    })(),
  ]);
  sent.push(...inTurn);
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

type Subscription = typeof webhookSubscriptions.$inferSelect;

/** The subscription's secret, and the one before it while a rotation's grace period lasts. */
async function signingSecrets(env: Env, sub: Subscription) {
  const context = secretContext.webhookSubscription(sub.id);
  const current = await openSecret(env, sub.secret, context);
  if (!sub.previousSecret || !sub.previousExpiresAt || sub.previousExpiresAt <= Date.now())
    return [current];
  return [current, await openSecret(env, sub.previousSecret, context)];
}

async function send(env: Env, sub: Subscription, id: string, event: string, body: string) {
  try {
    // Inside the try: a secret no key opens fails this delivery, not the step.
    const secrets = await signingSecrets(env, sub);
    // Behind the egress policy: no redirect takes a signed delivery anywhere else. A subscription
    // may point at a receiver on this machine in local development (`isWebhookUrl`).
    const res = await safeFetch(sub.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: await signWebhook(secrets, body),
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: id,
      },
      body,
      loopback: true,
      timeoutMs: TIMEOUT_MS,
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
