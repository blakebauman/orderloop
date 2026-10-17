/**
 * The checkout and order operations, the same for REST (./rest.ts) and MCP (./mcp.ts). Each
 * returns an HTTP status and the UCP body; the transports only frame them.
 *
 * Sessions live in D1 (`checkout_sessions`), the session JSON beside the fields queries use. Every
 * write compares the version it read, so an update racing a completion loses (409) instead of
 * changing a session that is being paid for. A session is priced again on every write, and once
 * more right before completing, by the checkout flow's own pricing nodes (./quote.ts).
 */

import {
  CHECKOUT_TTL_MS,
  type CheckoutIssue,
  type CheckoutPatch,
  type CheckoutSession,
  checkoutPatch,
  type FlowVersion,
  isExpired,
  isFinalCheckout,
  isOpenCheckout,
  missingInfo,
  newId,
  ORDER_CAPABILITY,
  type OrderState,
  openStatus,
  orderPermalink,
  type PlatformCaller,
  patchCheckout,
  protocolIssues,
  selectedInstrument,
  toUcpCheckout,
  toUcpOrder,
  type UcpCapability,
  type UcpCheckoutInput,
  type UcpSettings,
  ucpCompleteInput,
  ucpError,
  ucpErrorResponse,
} from '@orderloop/core';
import { checkoutSessions, createDb, payments, products, shipments } from '@orderloop/db';
import { and, eq, inArray } from 'drizzle-orm';
import { loadFlowVersion } from '../flows';
import { orderAgent } from '../namespaces';
import { startOrderOnce } from '../orders';
import { CHECKOUT_CURRENCY, paymentHandlers, ucpSettings } from './config';
import { authorizeCheckout, releaseHold } from './payments';
import { quoteCheckout } from './quote';

export type UcpResult = { status: number; body: unknown };

/** Who is asking, and what was negotiated with them. */
export type UcpContext = {
  caller: PlatformCaller;
  capabilities: Map<UcpCapability, string>;
};

const protocol = (status: number, code: string, content: string): UcpResult => ({
  status,
  body: ucpError(code, content),
});

const gone = (content: string): UcpResult => ({
  status: 200,
  body: ucpErrorResponse([
    { kind: 'error', code: 'not_found', content, severity: 'unrecoverable' },
  ]),
});

const db = (env: Env) => createDb(env.DB);

async function load(env: Env, ownerId: string, id: string): Promise<CheckoutSession | null> {
  const row = await db(env)
    .select({ data: checkoutSessions.data, ownerId: checkoutSessions.ownerId })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, id))
    .get();
  // Another platform's session is not found, not forbidden: its id says nothing.
  return row && row.ownerId === ownerId ? (JSON.parse(row.data) as CheckoutSession) : null;
}

/** Writes `next` over the version it was read at; false when someone wrote in between. */
async function save(env: Env, next: CheckoutSession, readVersion: number): Promise<boolean> {
  const res = await db(env)
    .update(checkoutSessions)
    .set({
      status: next.status,
      data: JSON.stringify(next),
      orderId: next.orderId,
      version: next.version,
      updatedAt: next.updatedAt,
      expiresAt: next.expiresAt,
    })
    .where(and(eq(checkoutSessions.id, next.id), eq(checkoutSessions.version, readVersion)))
    .returning({ id: checkoutSessions.id });
  return res.length > 0;
}

const bump = (s: CheckoutSession, changes: Partial<CheckoutSession>): CheckoutSession => ({
  ...s,
  ...changes,
  version: s.version + 1,
  updatedAt: Date.now(),
});

const raced = () =>
  protocol(409, 'conflict', 'The checkout changed while this request ran; get it and try again.');

async function checkoutFlow(env: Env, settings: UcpSettings): Promise<FlowVersion | null> {
  return settings.checkoutFlowId ? loadFlowVersion(env, settings.checkoutFlowId) : null;
}

/** Prices the session and works out its issues and status (for a session that is open). */
async function refresh(
  env: Env,
  flow: FlowVersion,
  s: CheckoutSession,
  ctx: UcpContext,
): Promise<CheckoutSession> {
  const { quote, issues } = await quoteCheckout(env, flow, s);
  const priced = { ...s, quote };
  const all: CheckoutIssue[] = [
    ...issues,
    ...missingInfo(priced),
    ...protocolIssues(priced, ctx.capabilities),
  ];
  return { ...priced, issues: all, status: openStatus(all) };
}

async function respond(
  env: Env,
  s: CheckoutSession,
  ctx: UcpContext,
  status = 200,
  settings?: UcpSettings,
): Promise<UcpResult> {
  const conf = settings ?? (await ucpSettings(env));
  return {
    status,
    body: toUcpCheckout(s, {
      capabilities: ctx.capabilities,
      handlers: paymentHandlers(env),
      settings: conf,
      ...(s.orderId ? { permalink: orderPermalink(conf, ctx.caller.origin, s.orderId) } : {}),
    }),
  };
}

/** The session, expired first if its time is up. */
async function current(env: Env, ctx: UcpContext, id: string) {
  const s = await load(env, ctx.caller.id, id);
  if (!s || !isExpired(s, Date.now())) return s;
  const expired = bump(s, {
    status: 'canceled',
    issues: [{ kind: 'info', code: 'expired', content: 'This checkout expired.' }],
  });
  return (await save(env, expired, s.version)) ? expired : load(env, ctx.caller.id, id);
}

export async function createCheckout(
  env: Env,
  ctx: UcpContext,
  input: UcpCheckoutInput,
): Promise<UcpResult> {
  const settings = await ucpSettings(env);
  const flow = await checkoutFlow(env, settings);
  if (!flow) return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  const now = Date.now();
  const empty: CheckoutSession = {
    id: newId('chk'),
    ownerId: ctx.caller.id,
    status: 'incomplete',
    currency: CHECKOUT_CURRENCY,
    lines: [],
    buyer: {},
    fulfillment: 'ship',
    shipTo: null,
    shippingOption: null,
    quote: null,
    issues: [],
    orderId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CHECKOUT_TTL_MS,
    version: 1,
  };
  const s = await refresh(env, flow, patchCheckout(empty, checkoutPatch(input)), ctx);
  // Nothing in it can be bought: there is no checkout to create.
  const unavailable = s.issues.filter((i) => i.code === 'item_unavailable');
  if (unavailable.length === s.lines.length)
    return {
      status: 200,
      body: ucpErrorResponse(
        unavailable.map((i) => ({ ...i, severity: 'unrecoverable' as const })),
      ),
    };
  await db(env)
    .insert(checkoutSessions)
    .values({
      id: s.id,
      ownerId: s.ownerId,
      status: s.status,
      data: JSON.stringify(s),
      orderId: null,
      version: s.version,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      expiresAt: s.expiresAt,
    });
  return respond(env, s, ctx, 201, settings);
}

export async function getCheckout(env: Env, ctx: UcpContext, id: string): Promise<UcpResult> {
  const s = await current(env, ctx, id);
  return s ? respond(env, s, ctx) : gone('No such checkout.');
}

/** A refusal shown on the checkout as it is, without changing it. */
const asIs = (s: CheckoutSession, content: string, code = 'not_allowed'): CheckoutSession => ({
  ...s,
  issues: [...s.issues, { kind: 'error', code, content, severity: 'recoverable' }],
});

export async function updateCheckout(
  env: Env,
  ctx: UcpContext,
  id: string,
  input: UcpCheckoutInput,
): Promise<UcpResult> {
  const s = await current(env, ctx, id);
  if (!s) return gone('No such checkout.');
  if (s.status === 'complete_in_progress')
    return respond(env, asIs(s, 'The checkout is being completed; it cannot change now.'), ctx);
  if (isFinalCheckout(s))
    return respond(env, asIs(s, `The checkout is ${s.status}; start a new one.`), ctx);
  const settings = await ucpSettings(env);
  const flow = await checkoutFlow(env, settings);
  if (!flow) return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  const patch: CheckoutPatch = checkoutPatch(input, s);
  const next = await refresh(env, flow, bump(patchCheckout(s, patch), {}), ctx);
  if (!(await save(env, next, s.version))) return raced();
  return respond(env, next, ctx, 200, settings);
}

export async function cancelCheckout(env: Env, ctx: UcpContext, id: string): Promise<UcpResult> {
  const s = await current(env, ctx, id);
  if (!s) return gone('No such checkout.');
  if (!isOpenCheckout(s))
    return protocol(409, 'not_cancelable', `The checkout is ${s.status} and can't be canceled.`);
  const next = bump(s, { status: 'canceled', issues: [] });
  if (!(await save(env, next, s.version))) return raced();
  return respond(env, next, ctx);
}

export async function completeCheckout(
  env: Env,
  ctx: UcpContext,
  id: string,
  raw: unknown,
): Promise<UcpResult> {
  const parsed = ucpCompleteInput.safeParse(raw);
  if (!parsed.success)
    return protocol(
      400,
      'invalid_request',
      `Complete needs payment.instruments: ${parsed.error.issues[0]?.message}`,
    );
  const s = await current(env, ctx, id);
  if (!s) return gone('No such checkout.');
  if (s.status === 'completed' || s.status === 'complete_in_progress') return respond(env, s, ctx);
  if (s.status === 'canceled') return respond(env, asIs(s, 'The checkout was canceled.'), ctx);

  const settings = await ucpSettings(env);
  const flow = await checkoutFlow(env, settings);
  if (!flow) return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  // Priced again now: the hold must be for what the flow will charge.
  const fresh = await refresh(env, flow, s, ctx);
  if (fresh.status !== 'ready_for_complete') {
    const next = bump(fresh, {});
    if (!(await save(env, next, s.version))) return raced();
    return respond(env, next, ctx, 200, settings);
  }

  const instrument = selectedInstrument(parsed.data);
  const handler = paymentHandlers(env).find((h) => h.id === instrument?.handler_id);
  const failed = async (code: string, content: string) => {
    const next = bump(fresh, {
      status: 'ready_for_complete',
      issues: [{ kind: 'error', code, content, path: '$.payment', severity: 'recoverable' }],
    });
    return (await save(env, next, s.version)) ? respond(env, next, ctx, 200, settings) : raced();
  };
  if (!instrument || !handler)
    return failed(
      'payment_failed',
      'Select one instrument of a payment handler this checkout offers.',
    );

  // Claim the session: from here no update can change what is being paid for.
  const claimed = bump(fresh, { status: 'complete_in_progress', issues: [] });
  if (!(await save(env, claimed, s.version))) return raced();

  let auth: Awaited<ReturnType<typeof authorizeCheckout>>;
  try {
    auth = await authorizeCheckout(env, claimed, handler.name, instrument);
  } catch (err) {
    // The processor failed, not the card: open the session again so the platform can retry.
    await save(env, bump(claimed, { status: 'ready_for_complete' }), claimed.version);
    throw err;
  }
  if (!auth.ok) {
    const next = bump(claimed, {
      status: 'ready_for_complete',
      issues: [
        {
          kind: 'error',
          code: auth.code,
          content: auth.content,
          path: '$.payment',
          severity: 'recoverable',
        },
      ],
    });
    return (await save(env, next, claimed.version))
      ? respond(env, next, ctx, 200, settings)
      : raced();
  }

  const q = claimed.quote!;
  const name = [claimed.buyer.firstName, claimed.buyer.lastName].filter(Boolean).join(' ');
  let orderId: string;
  try {
    const started = await startOrderOnce(env, {
      flowId: flow.id,
      version: flow.version,
      idempotencyKey: `ucp:${claimed.id}`,
      startedBy: ctx.caller.id,
      input: {
        model: flow.model,
        channel: 'agent',
        externalId: claimed.id,
        title: `Checkout ${claimed.id}`,
        currency: claimed.currency,
        lines: q.lines.map((l) => ({ sku: l.sku, name: l.title, qty: l.qty })),
        contact: {
          email: claimed.buyer.email!,
          ...(name ? { name } : {}),
          ...(claimed.buyer.phone ? { phone: claimed.buyer.phone } : {}),
        },
        fulfillment: { method: q.ships ? 'ship' : 'digital' },
        ...((claimed.shippingOption ?? q.shippingOption)
          ? { shippingOption: (claimed.shippingOption ?? q.shippingOption)! }
          : {}),
        ...(auth.payment ? { payment: auth.payment } : {}),
        meta: {
          ...(claimed.shipTo ? { shipTo: claimed.shipTo } : {}),
          ucp: { platformId: ctx.caller.id, checkoutId: claimed.id, origin: ctx.caller.origin },
        },
      },
    });
    if ('mismatch' in started)
      throw new Error('An order already exists for this checkout with other details');
    orderId = started.orderId;
  } catch (err) {
    if (auth.payment?.intentId) await releaseHold(env, auth.payment.intentId);
    const next = bump(claimed, {
      status: 'ready_for_complete',
      issues: [
        {
          kind: 'error',
          code: 'order_failed',
          content: 'The order could not be placed; try again.',
          severity: 'recoverable',
        },
      ],
    });
    await save(env, next, claimed.version);
    throw err;
  }
  const done = bump(claimed, { status: 'completed', orderId, issues: [] });
  if (!(await save(env, done, claimed.version))) return raced();
  return respond(env, done, ctx, 200, settings);
}

// ── Orders ────────────────────────────────────────────────────────────────

/** The session that placed `orderId`, if this platform's. */
export async function sessionForOrder(env: Env, orderId: string) {
  const row = await db(env)
    .select({ data: checkoutSessions.data })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.orderId, orderId))
    .get();
  return row ? (JSON.parse(row.data) as CheckoutSession) : null;
}

/** The UCP order entity for an order a checkout placed, or null. */
export async function orderEntity(
  env: Env,
  orderId: string,
  capabilities: Map<UcpCapability, string>,
  origin: string,
) {
  const s = await sessionForOrder(env, orderId);
  if (!s) return null;
  const state = (await orderAgent(env, orderId).snapshot()) as OrderState;
  if (!state.order) return null;
  const d = db(env);
  const [ships, paid, catalog, settings] = await Promise.all([
    d.select().from(shipments).where(eq(shipments.orderId, orderId)),
    d
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.kind, 'refund'))),
    d
      .select({ sku: products.sku, kind: products.kind })
      .from(products)
      .where(
        inArray(
          products.sku,
          state.order.lines.map((l) => l.sku),
        ),
      ),
    ucpSettings(env),
  ]);
  return {
    session: s,
    state,
    entity: toUcpOrder(
      {
        order: state.order,
        status: state.status,
        checkoutId: s.id,
        checkoutLines: s.lines,
        physical: new Set(catalog.filter((p) => p.kind !== 'digital').map((p) => p.sku)),
        shipTo: s.shipTo,
        shipments: ships,
        refunds: paid.map((r) => ({
          id: r.id,
          amount: r.amount,
          status: r.status,
          createdAt: r.createdAt,
        })),
        updatedAt: state.updatedAt,
        permalink: orderPermalink(settings, origin, orderId),
      },
      capabilities,
    ),
  };
}

export async function getOrder(env: Env, ctx: UcpContext, orderId: string): Promise<UcpResult> {
  if (!ctx.capabilities.has(ORDER_CAPABILITY))
    return protocol(
      403,
      'forbidden',
      'The platform profile does not support dev.ucp.shopping.order.',
    );
  const found = await orderEntity(env, orderId, ctx.capabilities, ctx.caller.origin);
  if (!found || found.session.ownerId !== ctx.caller.id) return gone('Order not found.');
  return { status: 200, body: found.entity };
}
