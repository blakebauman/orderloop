/** Opening carts, for EngineApi. A cart's own changes go through its agent (./agent.ts). */

import {
  applyLines,
  type Cart,
  type CartActor,
  type CartAnswer,
  type CartOp,
  type CartState,
  type CartStatus,
  type CartView,
  type CreateCartInput,
  cartOpSchema,
  cartView,
  type ExternalCart,
  type ExternalCartInput,
  type ExternalCartOpened,
  externalCartProblem,
  isFinalCart,
  MAX_CART_TITLE,
  newCart,
  newId,
  type PluginCart,
  quoteNodes,
  type StaffCartActor,
} from '@orderloop/core';
import { carts, createDb, customers } from '@orderloop/db';
import { and, eq } from 'drizzle-orm';
import { loadFlowVersion } from '../flows';
import { cartAgent } from '../namespaces';

/** Why `flowId` can't price a cart, or null: it must exist and set prices (`commerce.price`). */
export async function cartFlowProblem(env: Env, flowId: string): Promise<string | null> {
  const flow = await loadFlowVersion(env, flowId);
  if (!flow) return 'That flow has no published version.';
  if (!quoteNodes(flow).some((n) => n.type === 'commerce.price'))
    return 'That flow doesn’t price orders (it has no Price lines step).';
  return null;
}

export async function createCart(
  env: Env,
  input: CreateCartInput,
  external: ExternalCart | null = null,
  lines: { sku: string; qty: number }[] = [],
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim();
  if (!title || title.length > MAX_CART_TITLE)
    return { ok: false, error: `A title is 1 to ${MAX_CART_TITLE} characters.` };
  const problem = await cartFlowProblem(env, input.flowId);
  if (problem) return { ok: false, error: problem };
  if (input.customerId) {
    const found = await createDb(env.DB)
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .get();
    if (!found) return { ok: false, error: 'No such customer.' };
  }
  const cart = newCart({
    id: newId('cart'),
    title,
    flowId: input.flowId,
    customerId: input.customerId ?? null,
    external,
    lines: applyLines([], lines),
    createdBy: input.createdBy,
    now: Date.now(),
  });
  await cartAgent(env, cart.id).create(cart);
  return { ok: true, id: cart.id };
}

/** The cart's state, or null when no cart has the id (its agent is never woken for one). */
export async function cartSnapshot(env: Env, id: string): Promise<CartState | null> {
  const row = await createDb(env.DB)
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.id, id))
    .get();
  return row ? cartAgent(env, id).snapshot() : null;
}

/**
 * A staff cart, or null for an id no cart has or an external one: the REST API, MCP and the
 * assistant reach only staff carts, since an external cart belongs to the buyer's page.
 */
export async function staffCart(env: Env, id: string): Promise<Cart | null> {
  const c = (await cartSnapshot(env, id))?.cart;
  return c && !c.external ? c : null;
}

const NO_CART = { ok: false as const, error: 'No such cart.', notFound: true as const };
// The type says staff, but the binding carries whatever its caller sent.
const NOT_STAFF = { ok: false as const, error: 'Only staff change a cart this way.' };

/** One op as `actor`, then the cart as it is now (priced again when the op changed its lines). */
export async function changeCart(
  env: Env,
  id: string,
  op: CartOp,
  actor: StaffCartActor,
): Promise<CartAnswer<{ cart: CartView }>> {
  if (actor?.kind !== 'staff') return NOT_STAFF;
  const parsed = cartOpSchema.safeParse(op);
  if (!parsed.success) return { ok: false, error: 'That is not a cart change.' };
  if (!(await staffCart(env, id))) return NO_CART;
  const r = await cartAgent(env, id).applyAs(actor, parsed.data);
  if (!r.ok) return r;
  return { ok: true, cart: cartView((await staffCart(env, id))!) };
}

/** `confirmedVersion`: the version a confirmed preview showed; a cart changed since is refused. */
export async function submitCart(
  env: Env,
  id: string,
  actor: StaffCartActor,
  confirmedVersion?: number,
): Promise<CartAnswer<{ orderId: string }>> {
  if (actor?.kind !== 'staff') return NOT_STAFF;
  if (!(await staffCart(env, id))) return NO_CART;
  return cartAgent(env, id).submitAs(actor, confirmedVersion);
}

export async function cancelCart(
  env: Env,
  id: string,
  actor: StaffCartActor,
): Promise<CartAnswer<{ cart: CartView }>> {
  if (actor?.kind !== 'staff') return NOT_STAFF;
  if (!(await staffCart(env, id))) return NO_CART;
  const r = await cartAgent(env, id).cancelAs(actor);
  if (!r.ok) return r;
  return { ok: true, cart: cartView((await staffCart(env, id))!) };
}

/**
 * Opens (or finds) the external cart for a plugin's session and a fresh start link for its buyer.
 * The same `sessionRef` finds the same cart, so a buyer's system asking again gets them back to it.
 */
export async function openExternalCart(
  env: Env,
  pluginId: string,
  input: ExternalCartInput,
): Promise<{ ok: true; cart: ExternalCartOpened } | { ok: false; error: string }> {
  const now = Date.now();
  const own = String(env.OWN_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const problem = externalCartProblem(input, now, own);
  if (problem) return { ok: false, error: problem };
  const title = String(input.title ?? '').trim();
  if (!title || title.length > MAX_CART_TITLE)
    return { ok: false, error: `A title is 1 to ${MAX_CART_TITLE} characters.` };
  const db = createDb(env.DB);
  const existing = () =>
    db
      .select({ id: carts.id, status: carts.status })
      .from(carts)
      .where(and(eq(carts.pluginId, pluginId), eq(carts.sessionRef, input.sessionRef)))
      .get();
  let found = await existing();
  if (!found) {
    const made = await createCart(
      env,
      {
        title,
        flowId: input.flowId,
        customerId: input.customerId ?? null,
        createdBy: `plugin:${pluginId}`,
      },
      {
        pluginId,
        sessionRef: input.sessionRef,
        expiresAt: input.expiresAt,
        idleMs: input.idleMs ?? null,
        returnUrl: input.returnUrl,
        frameOrigins: input.frameOrigins ?? [],
        buyer: { id: input.buyer.id, name: input.buyer.name },
      },
      input.lines ?? [],
    ).catch(async (err) => {
      // Two opens of one session at once: the unique index let one in; use it.
      if ((await existing()) !== undefined) return null;
      throw err;
    });
    if (made && !made.ok) return made;
    found = await existing();
    if (!found) return { ok: false, error: 'The cart could not be opened.' };
  }
  if (isFinalCart({ status: found.status as CartStatus }))
    return { ok: false, error: `That session’s cart is ${found.status}.` };
  const token = await cartAgent(env, found.id).issueStart();
  if (!token) return { ok: false, error: 'That session’s cart has closed.' };
  const startPath = `/cart/start/${found.id}/${token}`;
  return {
    ok: true,
    cart: {
      cartId: found.id,
      startPath,
      startUrl: env.APP_ORIGIN ? `${env.APP_ORIGIN}${startPath}` : null,
    },
  };
}

/**
 * The buyer an external cart's start link admits, once (`CartAgent.redeemStart`), and until when:
 * the latest the cart can stay open (`externalCartEnd`), so their cookie outlasts every extension
 * of a cart that stays open while they work. The cart's own time still decides when it closes.
 */
export async function redeemCartStart(env: Env, cartId: string, token: string) {
  const row = await createDb(env.DB)
    .select({ pluginId: carts.pluginId })
    .from(carts)
    .where(eq(carts.id, cartId))
    .get();
  if (!row?.pluginId) return null;
  const agent = cartAgent(env, cartId);
  const guest = await agent.redeemStart(token);
  const expiresAt = guest ? await agent.admittedUntil() : null;
  return guest && expiresAt ? { guest, expiresAt } : null;
}

/**
 * A request from an external cart's buyer outside its socket, as activity on it (`keepOpenFor`).
 * Only an external cart's agent is woken: never one for an id no cart has.
 */
export async function keepCartOpen(env: Env, cartId: string, actor: CartActor) {
  if (actor.kind !== 'guest') return;
  const row = await createDb(env.DB)
    .select({ pluginId: carts.pluginId })
    .from(carts)
    .where(eq(carts.id, cartId))
    .get();
  if (row?.pluginId) await cartAgent(env, cartId).keepOpenFor(actor);
}

/** A cart as the plugin that opened it sees it, or null for anyone else's. */
export async function pluginCart(
  env: Env,
  pluginId: string,
  cartId: string,
): Promise<PluginCart | null> {
  const c = (await cartSnapshot(env, cartId))?.cart;
  if (!c || c.external?.pluginId !== pluginId) return null;
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    customerId: c.customerId,
    lines: c.lines,
    quote: c.quote,
    orderId: c.orderId,
    updatedAt: c.updatedAt,
    sessionRef: c.external.sessionRef,
  };
}
