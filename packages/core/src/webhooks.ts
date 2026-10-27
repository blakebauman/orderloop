/**
 * Signed webhooks. External systems (payment providers, a WMS, storefronts) resume and start
 * orders by POSTing a body signed with their integration's secret instead of holding a token;
 * `k` names the integration, so OrderLoop knows which secret to check and what it may do (see
 * ./integrations.ts). Outbound deliveries use the same scheme without `k`.
 *
 *   X-OrderLoop-Signature: t=<unix seconds>,k=<integration id>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>
 *
 * The timestamp is part of the signed payload and must be within `toleranceSec` of now, so a
 * captured request can't be replayed later.
 */

import { egressProblem } from './egress';

export const SIGNATURE_HEADER = 'x-orderloop-signature';

/**
 * Where OrderLoop may POST to: what the egress policy lets a delivery reach, with plain http on this
 * machine for local development. Used for webhook subscriptions and A2A push notification URLs, so
 * one is refused when it's registered rather than at every delivery.
 */
export const isWebhookUrl = (url: string): boolean =>
  egressProblem(url, { loopback: true }) === null;

export const WEBHOOK_URL_RULE =
  'Use an https URL with a public host name (no IP address or internal name; plain http is allowed only for localhost)';

const enc = new TextEncoder();

/** Imported keys per secret, so a delivery or check doesn't import its key again. Bounded. */
const keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();
const MAX_KEYS = 64;

function hmacKey(secret: string) {
  let key = keys.get(secret);
  if (!key) {
    if (keys.size >= MAX_KEYS) keys.clear();
    key = crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    // A failed import is not kept, so the next call tries again.
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant time for equal-length strings; different lengths fail fast, which leaks only length. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Builds the signature header value for `rawBody` (what a sender does): one `v1` per secret, so
 * while a secret is rotated the receiver can check with either the new one or the old.
 */
export async function signWebhook(
  secret: string | readonly string[],
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
  keyId?: string,
) {
  const k = keyId ? `,k=${keyId}` : '';
  const sigs = await Promise.all(
    (typeof secret === 'string' ? [secret] : secret).map((s) => hmacHex(s, `${nowSec}.${rawBody}`)),
  );
  return `t=${nowSec}${k}${sigs.map((v) => `,v1=${v}`).join('')}`;
}

/** `t=1,v1=a,v1=b` → `{t: ['1'], v1: ['a', 'b']}`: a key may repeat. */
function headerParts(header: string): Map<string, string[]> {
  const parts = new Map<string, string[]>();
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), p.slice(i + 1).trim()]);
  }
  return parts;
}

/** The integration a signature names (`k=`), if any. */
export const signatureKeyId = (header: string | null): string | undefined =>
  header ? headerParts(header).get('k')?.[0] || undefined : undefined;

/**
 * `signature` is the one that matched, as this side computed it (lower-case hex), and `t` the
 * signed timestamp. A replay check keys on `t` and the body, never on the signature: during a
 * rotation one delivery can be signed under two secrets, and either copy verifies.
 */
export type VerifyResult =
  | { ok: true; signature: string; t: number }
  | { ok: false; reason: string };

/**
 * Checks a signature against `secret`, or against each of several (a key being rotated). The header
 * may carry several `v1` signatures (Stripe sends one per signing secret while one is rolled); any
 * one that matches any secret passes.
 */
export async function verifyWebhook(
  secret: string | readonly string[],
  rawBody: string,
  header: string | null,
  { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {},
): Promise<VerifyResult> {
  if (!header) return { ok: false, reason: 'Missing signature header' };
  const parts = headerParts(header);
  const t = Number(parts.get('t')?.[0]);
  const given = (parts.get('v1') ?? []).filter(Boolean).map((v) => v.toLowerCase());
  if (!parts.get('t')?.[0] || !Number.isFinite(t) || !given.length)
    return { ok: false, reason: 'Malformed signature header' };
  if (Math.abs(nowSec - t) > toleranceSec)
    return { ok: false, reason: 'Signature timestamp outside tolerance' };
  for (const s of typeof secret === 'string' ? [secret] : secret) {
    const expected = await hmacHex(s, `${t}.${rawBody}`);
    // Every candidate is compared, so the time taken doesn't say which one matched.
    let match = false;
    for (const v of given) match = constantTimeEqual(expected, v) || match;
    if (match) return { ok: true, signature: expected, t };
  }
  return { ok: false, reason: 'Signature mismatch' };
}

// ── Stripe ─────────────────────────────────────────────────────────────────

/**
 * Stripe's webhook signature: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…][,v0=…]`, an
 * HMAC-SHA256 of `${t}.${rawBody}` with the endpoint's signing secret (`whsec_…`): the same scheme
 * as ours without `k`. During a secret roll Stripe signs with both secrets, so several `v1`s come.
 */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string | null,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): Promise<VerifyResult> {
  return verifyWebhook(secret, rawBody, header, opts);
}

// ── Outbound ───────────────────────────────────────────────────────────────

/**
 * Order and cart events sent to webhook subscribers, signed with each subscription's own secret
 * using the same header scheme. `X-OrderLoop-Delivery` is stable across retries so receivers can
 * dedupe.
 */
export const EVENT_HEADER = 'x-orderloop-event';
export const DELIVERY_HEADER = 'x-orderloop-delivery';

export const ORDER_EVENTS = [
  'order.paid',
  'order.invoiced',
  'order.shipped',
  'order.ready_for_pickup',
  'order.delivered',
  'order.refunded',
  'order.payout_scheduled',
  'order.completed',
  'order.declined',
  'order.cancelled',
  'order.failed',
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

/**
 * A cart's opening and its ending, sent by its CartAgent. A cart's edits send nothing: it changes
 * on every line, quantity and code while people build it, and what it came to is in the ending
 * event (`cart.submitted` with its order, `cart.returned` to the buyer's system).
 */
export const CART_EVENTS = [
  'cart.created',
  'cart.submitted',
  'cart.returned',
  'cart.canceled',
  'cart.expired',
] as const;
export type CartEvent = (typeof CART_EVENTS)[number];

export const OUTBOUND_EVENTS = [...ORDER_EVENTS, ...CART_EVENTS] as const;
export type OutboundEvent = OrderEvent | CartEvent;

export const isCartEvent = (event: string): event is CartEvent =>
  (CART_EVENTS as readonly string[]).includes(event);

/**
 * How often a cart's event is retried after its first attempt, from its CartAgent's schedule: 10
 * seconds doubling to an hour (`cartEventRetryDelaySec`), then hourly, about a day in all, so a
 * receiver down overnight still gets it. The delivery then stays `failed`.
 */
export const CART_EVENT_RETRIES = 32;
export const cartEventRetryDelaySec = (attempt: number) => Math.min(10 * 2 ** attempt, 3600);

/** Nodes that emit an event when they finish, and the branch that counts as success. */
export const NODE_EVENTS: Record<string, { event: OrderEvent; branch?: string }> = {
  'commerce.capture_payment': { event: 'order.paid', branch: 'ok' },
  'commerce.charge': { event: 'order.paid', branch: 'ok' },
  'commerce.invoice': { event: 'order.invoiced' },
  'commerce.ship': { event: 'order.shipped' },
  'commerce.pickup_ready': { event: 'order.ready_for_pickup' },
  'commerce.handover': { event: 'order.delivered' },
  'commerce.deliver_digital': { event: 'order.delivered' },
  'commerce.refund': { event: 'order.refunded', branch: 'ok' },
  'commerce.payout': { event: 'order.payout_scheduled' },
};

type PayloadBase = { id: string; occurredAt: number; data: Record<string, unknown> };

export type OrderEventPayload = PayloadBase & { event: OrderEvent; orderId: string };

/** `orderId` is the order the cart was submitted as, once it was. */
export type CartEventPayload = PayloadBase & {
  event: CartEvent;
  cartId: string;
  orderId: string | null;
};

export type OutboundPayload = OrderEventPayload | CartEventPayload;

/** The payload an event of type `E` arrives with. */
export type PayloadOf<E extends OutboundEvent> = E extends CartEvent
  ? CartEventPayload
  : OrderEventPayload;

/** A subscription's event filter: exact names, or "*" for everything. */
export function subscribedTo(events: readonly string[], event: string): boolean {
  return events.includes('*') || events.includes(event);
}
