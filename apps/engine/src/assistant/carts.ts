/**
 * Carts for the workspace tools (tools.ts): list, read, open and change staff carts, and the
 * submit action's preview and run (data.ts). Everything goes through the cart's agent as the
 * caller (`staffCartActor`), so a tool does what the person could do on the cart's page and no
 * more. External carts belong to their buyer's page and aren't reached from here.
 *
 * What a cart says is people's text (its title, its lines' names, the quote's problems): it goes
 * to the model bounded to a line each, as data, and its chat and files never do.
 */

import {
  type ActionPreview,
  ASSISTANT_TOOLS,
  atLeast,
  boundText,
  CART_CHANGED_SINCE_CONFIRM,
  type Cart,
  type CartOp,
  type CartStatus,
  cartReadyProblem,
  isQuoteCurrent,
  type Principal,
  ROLE_LABELS,
  staffCartActor,
} from '@orderloop/core';
import { carts, createDb, customers, flows } from '@orderloop/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { recordAudit } from '../audit';
import { changeCart as applyToCart, createCart, staffCart, submitCart } from '../cart/carts';
import { AUDIT_CHANNEL, type Channel, type Confirmed, money, orderRef, Refused } from './data';

/** A cart's own words, one bounded line, for the model. */
const said = (v: string | null | undefined, max = 120) => boundText(v, max) ?? undefined;

async function loadCart(env: Env, cartId: string): Promise<Cart> {
  const c = await staffCart(env, cartId.trim());
  if (!c) throw new Refused(`No cart matches ${cartId}.`);
  return c;
}

const customerName = async (env: Env, id: string | null) =>
  id
    ? ((
        await createDb(env.DB)
          .select({ name: customers.name })
          .from(customers)
          .where(eq(customers.id, id))
          .get()
      )?.name ?? id)
    : null;

const flowName = async (env: Env, id: string) =>
  (await createDb(env.DB).select({ name: flows.name }).from(flows).where(eq(flows.id, id)).get())
    ?.name ?? id;

export async function listCarts(env: Env, f: { status?: CartStatus; limit?: number }) {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 50);
  const rows = await createDb(env.DB)
    .select({
      id: carts.id,
      title: carts.title,
      status: carts.status,
      customer: customers.name,
      customerId: carts.customerId,
      flowId: carts.flowId,
      orderId: carts.orderId,
      updatedAt: carts.updatedAt,
    })
    .from(carts)
    .leftJoin(customers, eq(customers.id, carts.customerId))
    .where(and(isNull(carts.pluginId), f.status ? eq(carts.status, f.status) : undefined))
    .orderBy(desc(carts.updatedAt))
    .limit(limit);
  return {
    shown: rows.length,
    carts: rows.map((r) => ({
      id: r.id,
      title: said(r.title) ?? '',
      status: r.status,
      customer: said(r.customer ?? r.customerId ?? undefined) ?? null,
      flowId: r.flowId,
      orderId: r.orderId,
      updatedAt: new Date(r.updatedAt).toISOString(),
      href: `/carts/${r.id}`,
    })),
  };
}

/** One cart for the model: lines by id (change_cart names them), the quote, and what blocks it. */
export async function getCart(env: Env, cartId: string) {
  const c = await loadCart(env, cartId);
  const q = c.quote;
  const currency = q?.currency;
  return {
    id: c.id,
    href: `/carts/${c.id}`,
    title: said(c.title) ?? '',
    status: c.status,
    customer: said(await customerName(env, c.customerId)) ?? null,
    flow: said(await flowName(env, c.flowId)) ?? c.flowId,
    flowId: c.flowId,
    lines: c.lines.map((l) => ({
      lineId: l.id,
      sku: l.sku,
      title: said(l.title),
      qty: l.qty,
      unitPrice: l.unitPrice === undefined ? undefined : money(l.unitPrice, currency),
    })),
    promoCodes: c.promoCodes,
    shipTo: c.shipTo
      ? Object.fromEntries(Object.entries(c.shipTo).map(([f, v]) => [f, said(v)]))
      : null,
    shippingOption: c.shippingOption ?? q?.shippingOption ?? null,
    shippingOptions: (q?.shippingOptions ?? []).map((o) => ({
      id: o.id,
      title: said(o.title) ?? o.id,
      price: money(o.amount, q?.currency),
    })),
    priced: isQuoteCurrent(c),
    subtotal: q ? money(q.subtotal, q.currency) : '',
    shipping: q ? money(q.shipping, q.currency) : '',
    tax: q ? money(q.tax, q.currency) : '',
    total: q ? money(q.total, q.currency) : '',
    issues: c.issues.map((i) => ({ kind: i.kind, content: said(i.content, 200) ?? '' })),
    notReady: said(cartReadyProblem(c) ?? undefined, 200) ?? null,
    orderId: c.orderId,
    ...(c.orderId ? { orderHref: `/orders/${c.orderId}` } : {}),
  };
}

export async function openCart(
  env: Env,
  p: Principal,
  input: { title: string; flowId: string; customerId?: string },
  channel: Channel,
) {
  const made = await createCart(env, {
    title: input.title,
    flowId: input.flowId,
    customerId: input.customerId || null,
    createdBy: p.id,
  });
  if (!made.ok) throw new Refused(made.error);
  await recordAudit(env, 'cart.created', {
    actor: p,
    target: made.id,
    detail: { flowId: input.flowId, via: AUDIT_CHANNEL[channel], tool: 'create_cart' },
  });
  return getCart(env, made.id);
}

/**
 * Applies the ops in order, as the caller; stops at the first one the cart refuses. Each op that
 * goes in is audited (`cart.changed`), as a change through the REST API is.
 */
export async function changeCart(
  env: Env,
  p: Principal,
  cartId: string,
  ops: CartOp[],
  channel: Channel,
) {
  const c = await loadCart(env, cartId);
  const actor = staffCartActor(p);
  let applied = 0;
  for (const op of ops) {
    const r = await applyToCart(env, c.id, op, actor);
    if (!r.ok)
      throw new Refused(
        applied ? `Made ${applied} of ${ops.length} changes, then: ${r.error}` : r.error,
      );
    applied++;
    await recordAudit(env, 'cart.changed', {
      actor: p,
      target: c.id,
      detail: { op: op.op, via: AUDIT_CHANNEL[channel], tool: 'change_cart' },
    });
  }
  return { ...(await getCart(env, c.id)), applied };
}

/** A cart that moved on from the version a caller says it read. */
const movedOn = (v: number) => `The cart has changed since version ${v}; read it again.`;

export async function previewSubmit(
  env: Env,
  p: Principal,
  input: { cartId: string; cartVersion?: number },
): Promise<ActionPreview> {
  const min = ASSISTANT_TOOLS.submit_cart.role;
  const c = await loadCart(env, input.cartId);
  const read = input.cartVersion;
  const q = c.quote;
  const customer = said(await customerName(env, c.customerId), 80);
  const option = c.shippingOption ?? q?.shippingOption;
  const where = [c.shipTo?.line1, c.shipTo?.city, c.shipTo?.country].filter(Boolean).join(', ');
  const shipsTo = where
    ? `Ships to ${said(where, 120)}${option ? ` by ${said(q?.shippingOptions.find((o) => o.id === option)?.title ?? option, 40)}` : ''}`
    : null;
  return {
    title: `Submit the cart “${said(c.title, 80) ?? c.id}”`,
    href: `/carts/${c.id}`,
    consequences: [
      `${c.lines.length} line${c.lines.length === 1 ? '' : 's'}${q && isQuoteCurrent(c) ? ` · ${money(q.total, q.currency)}` : ''}`,
      `Starts an order of ${said(await flowName(env, c.flowId), 80) ?? c.flowId}${customer ? ` for ${customer}` : ''} with these lines`,
      'The order’s flow prices it again when it runs, so its total can differ from this quote',
      ...(c.promoCodes.length ? [`With ${c.promoCodes.join(', ')}`] : []),
      ...(shipsTo ? [shipsTo] : []),
      'The cart ends: no one can change it afterwards',
    ],
    blocked: !atLeast(p.role, min)
      ? `This needs the ${ROLE_LABELS[min]} role.`
      : read !== undefined && read !== c.version
        ? movedOn(read)
        : said(cartReadyProblem(c) ?? undefined, 200),
    // What the person sees is this version of the cart; confirming it submits only this version.
    bound: { cartVersion: c.version },
  };
}

/**
 * Submits the cart. `confirmed` is what the person's confirm was held to (the preview's `bound`,
 * kept by the server that showed it), or `direct` for a call its caller composed itself (a typed
 * A2A skill), which has no preview and is held only to the `cartVersion` it names, if any.
 * Without either, nothing is submitted.
 */
export async function runSubmit(
  env: Env,
  p: Principal,
  input: { cartId: string; cartVersion?: number },
  channel: Channel,
  confirmed?: Confirmed,
) {
  const c = await loadCart(env, input.cartId);
  const held = confirmed === 'direct' ? input.cartVersion : confirmed?.bound?.cartVersion;
  if (confirmed !== 'direct' && typeof held !== 'number')
    throw new Refused(CART_CHANGED_SINCE_CONFIRM);
  const version = typeof held === 'number' ? held : undefined;
  const r = await submitCart(env, c.id, staffCartActor(p), version);
  if (!r.ok)
    throw new Refused(
      confirmed === 'direct' && r.error === CART_CHANGED_SINCE_CONFIRM && version !== undefined
        ? movedOn(version)
        : r.error,
    );
  await recordAudit(env, 'order.started', {
    actor: p,
    target: r.orderId,
    detail: {
      flowId: c.flowId,
      cartId: c.id,
      via: AUDIT_CHANNEL[channel],
      tool: 'submit_cart',
    },
  });
  return {
    done: `Submitted the cart as order ${orderRef(r.orderId)}`,
    href: `/orders/${r.orderId}`,
    orderId: r.orderId,
  };
}
