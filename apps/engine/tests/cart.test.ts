import { introspectWorkflow, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  b2bOrderFlow,
  CART_TYPING_MS,
  type CartActor,
  type CartOp,
  type CartState,
  type CartTyping,
  cartShippingOption,
  isQuoteCurrent,
  type OrderState,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  storefrontOrderFlow,
} from '@orderloop/core';
import { carts, createDb, orders, promotions, publishFlow, sessions, users } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineApi } from '../src/api';
import { PROMO_TRIES } from '../src/cart/agent';
import { createCart } from '../src/cart/carts';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { purgeEndedCarts, RETENTION } from '../src/retention';
import { signed, signedActor } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
/** The cart calls as the web app makes them: each actor signed for its cart. */
const cartApi = {
  changeCart: async (id: string, op: CartOp, a: CartActor) =>
    api().changeCart(id, op, await signedActor(a, `cart:${id}`)),
  submitCart: async (id: string, a: CartActor, version?: number) =>
    api().submitCart(id, await signedActor(a, `cart:${id}`), version),
  cancelCart: async (id: string, a: CartActor) =>
    api().cancelCart(id, await signedActor(a, `cart:${id}`)),
  attachToCart: async (id: string, file: Parameters<EngineApi['attachToCart']>[1], a: CartActor) =>
    api().attachToCart(id, file, await signedActor(a, `cart:${id}`)),
};
const cart = (id: string) => env.CART_AGENT.getByName(id);
const state = async (id: string) => (await api().cartSnapshot(id)) as CartState;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

beforeAll(async () => {
  await ensureTemplates(env);
});

/** A person with a live session, as the web proxy describes them. */
async function who(role: Principal['role'], name: string): Promise<ProxiedPrincipal> {
  const id = `usr_cart_${name}`;
  const session = `sess_${id}`;
  await db()
    .insert(users)
    .values({ id, email: `${name}@example.com`, name, role, createdAt: Date.now() })
    .onConflictDoUpdate({ target: users.id, set: { role, disabledAt: null } });
  await db()
    .insert(sessions)
    .values({
      tokenHash: session,
      userId: id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })
    .onConflictDoNothing();
  return { kind: 'user', id, name, email: `${name}@example.com`, role, session };
}

const staff = (p: ProxiedPrincipal) => ({
  kind: 'staff' as const,
  id: p.id,
  name: p.name,
  role: p.role,
});

async function open(customerId: string | null = 'cus_northwind') {
  const made = await api().createCart({
    title: 'Q4 restock',
    flowId: 'tpl-b2b-order',
    customerId,
    createdBy: 'usr_cart_ada',
  });
  if (!made.ok) throw new Error(made.error);
  return made.id;
}

/** The response to opening the cart's socket the way the web proxy does, as `principal`. */
async function upgrade(
  cartId: string,
  principal: ProxiedPrincipal | null,
  { signFor, path = `/agents/cart-agent/${cartId}` }: { signFor?: string; path?: string } = {},
) {
  const headers = new Headers({ Upgrade: 'websocket' });
  if (principal) headers.set(PRINCIPAL_HEADER, await signed(principal, signFor ?? path));
  return worker.fetch(new Request(`http://engine${path}`, { headers }), env);
}

/** The cart's socket, opened as `principal`. */
async function socket(cartId: string, principal: ProxiedPrincipal) {
  const res = await upgrade(cartId, principal);
  const ws = res.webSocket;
  if (!ws) throw new Error(`socket refused: ${res.status}`);
  ws.accept();
  const pending = new Map<
    string,
    (m: { success: boolean; result?: unknown; error?: string }) => void
  >();
  let last: CartState | null = null;
  const states: CartState[] = [];
  const typings: CartTyping[] = [];
  let closedWith: number | null = null;
  ws.addEventListener('close', (e) => {
    closedWith = e.code;
  });
  const errors: string[] = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
    if (m.type === 'cf_agent_state') {
      last = m.state as CartState;
      states.push(last);
    }
    if (m.type === 'cart_typing') typings.push(m as CartTyping);
    if (m.type === 'cf_agent_state_error' || m.error) errors.push(String(m.error ?? m.type));
  });
  let n = 0;
  return {
    call: <T = unknown>(method: string, args: unknown[] = []) =>
      new Promise<{ success: boolean; result?: T; error?: string }>((resolve) => {
        const id = `c${++n}`;
        pending.set(id, resolve as never);
        ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
      }),
    seen: () => last,
    /** Every state broadcast so far, oldest first. */
    states: () => states,
    /** Every typing notice so far, oldest first. */
    typings: () => typings,
    closed: () => closedWith,
    errors: () => errors,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}

describe('opening carts', () => {
  it('refuses a flow that does not price, a missing customer and an empty title', async () => {
    const base = { title: 'x', flowId: 'tpl-b2b-order', createdBy: 'usr_1' };
    expect(await api().createCart({ ...base, flowId: 'flow_nope' })).toMatchObject({
      ok: false,
      error: 'That flow has no published version.',
    });
    expect(await api().createCart({ ...base, customerId: 'cus_nope' })).toMatchObject({
      ok: false,
      error: 'No such customer.',
    });
    expect((await api().createCart({ ...base, title: '  ' })).ok).toBe(false);
  });

  it('indexes the cart in D1 and has no snapshot for an unknown id', async () => {
    const id = await open();
    const row = await db().select().from(carts).where(eq(carts.id, id)).get();
    expect(row).toMatchObject({ title: 'Q4 restock', status: 'open', customerId: 'cus_northwind' });
    expect(await api().cartSnapshot('cart_nope')).toBeNull();
  });
});

describe('pricing a cart', () => {
  it('prices lines with the flow’s own nodes for the cart’s customer', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    expect(await cart(id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 10 })).toEqual({
      ok: true,
    });
    const s = await state(id);
    expect(isQuoteCurrent(s.cart!)).toBe(true);
    // Northwind's contract price for WID-100, not the 24.00 list price.
    expect(s.cart!.quote!.lines[0]).toMatchObject({ sku: 'WID-100', qty: 10, unitPrice: 21.5 });
    expect(s.cart!.lines[0]).toMatchObject({ title: 'Industrial widget', unitPrice: 21.5 });
    expect(s.cart!.quote!.subtotal).toBe(215);
  });

  it('reports a SKU the store does not sell, and is not ready', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'NOPE-1', qty: 1 });
    const s = await state(id);
    expect(s.cart!.quote).toBeNull();
    expect(s.cart!.issues).toEqual([
      expect.objectContaining({ kind: 'error', code: 'item_unavailable' }),
    ]);
    expect(await cart(id).submitAs(ada)).toEqual({ ok: false, error: 'NOPE-1 is not sold here.' });
  });
});

describe('shipping a cart', () => {
  const berlin = { line1: '1 Hauptstr.', city: 'Berlin', postalCode: '10115', country: 'DE' };
  async function openShipping() {
    const made = await api().createCart({
      title: 'Gaskets',
      flowId: 'tpl-storefront-order',
      customerId: 'cus_ada',
      createdBy: 'usr_cart_ada',
    });
    if (!made.ok) throw new Error(made.error);
    return made.id;
  }

  it('quotes shipping for the ship-to and option, and needs an address to submit', async () => {
    const id = await openShipping();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'GSK-010', qty: 5 });
    let c = (await state(id)).cart!;
    expect(c.quote).toMatchObject({ ships: true, shippingOption: 'standard' });
    expect(c.quote!.shippingOptions.map((o) => o.id)).toEqual(
      expect.arrayContaining(['standard', 'express']),
    );
    expect(await cart(id).submitAs(ada)).toEqual({
      ok: false,
      error: 'Add a complete ship-to address: street, city, postcode and country.',
    });

    expect(await cart(id).applyAs(ada, { op: 'set_ship_to', address: berlin })).toEqual({
      ok: true,
    });
    expect(await cart(id).applyAs(ada, { op: 'set_shipping_option', option: 'express' })).toEqual({
      ok: true,
    });
    c = (await state(id)).cart!;
    expect(isQuoteCurrent(c)).toBe(true);
    expect(c).toMatchObject({ shipTo: berlin, shippingOption: 'express' });
    // Express is 19.95 + 2.00 a unit, × 2.5 outside the US, as the order's own shipping node charges.
    expect(c.quote).toMatchObject({
      shippingOption: 'express',
      shipping: Math.round((19.95 + 2 * 5) * 2.5 * 100) / 100,
    });
    expect(c.quote!.total).toBeCloseTo(c.quote!.subtotal + c.quote!.shipping + c.quote!.tax, 2);
    expect(await cart(id).applyAs(ada, { op: 'set_shipping_option', option: 'teleport' })).toEqual({
      ok: false,
      error: 'The shipping option “teleport” is not offered.',
    });

    // Clearing the address takes the option with it, and the cart can't be submitted again.
    await cart(id).applyAs(ada, { op: 'set_ship_to', address: null });
    c = (await state(id)).cart!;
    expect(c).toMatchObject({ shipTo: null, shippingOption: null });
    expect(c.quote!.shippingOption).toBe('standard');
  });

  it('reports a chosen option the flow doesn’t offer, and keeps it chosen', async () => {
    const id = await openShipping();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'set_ship_to', address: berlin });
    // Nothing priced yet, so nothing to check it against until there are lines.
    await cart(id).applyAs(ada, { op: 'set_shipping_option', option: 'teleport' });
    await cart(id).applyAs(ada, { op: 'add', sku: 'GSK-010', qty: 1 });
    const c = (await state(id)).cart!;
    expect(c.shippingOption).toBe('teleport');
    expect(c.issues).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'fulfillment_option_unavailable' }),
    );
    expect(await cart(id).submitAs(ada)).toEqual({
      ok: false,
      error: 'The shipping option “teleport” is not offered.',
    });
  });

  it('starts the order with the ship-to and option the cart was quoted for', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const id = await openShipping();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'GSK-010', qty: 2 });
    await cart(id).applyAs(ada, { op: 'set_ship_to', address: berlin });
    await cart(id).applyAs(ada, { op: 'set_shipping_option', option: 'express' });
    const done = await cart(id).submitAs(ada);
    if (!done.ok) throw new Error(done.error);
    const order = ((await env.ORDER_AGENT.getByName(done.orderId).snapshot()) as OrderState).order!;
    expect(order.shippingOption).toBe('express');
    expect(order.meta?.shipTo).toEqual(berlin);
  });

  it('ships by what the quote charged when the flow picks its own option, and says so', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    // The storefront flow, with a shipping step that always takes the cheapest option.
    const base = storefrontOrderFlow();
    const flow = {
      ...base,
      id: 'test-cart-cheapest',
      nodes: base.nodes.map((n) =>
        n.id === 'shipping' ? { ...n, config: { ...n.config, select: 'cheapest' } } : n,
      ),
    };
    await publishFlow(db(), flow);
    const made = await api().createCart({
      title: 'Cheapest',
      flowId: flow.id,
      customerId: 'cus_ada',
      createdBy: 'usr_cart_ada',
    });
    if (!made.ok) throw new Error(made.error);
    const ada = staff(await who('operator', 'ada'));
    await cart(made.id).applyAs(ada, { op: 'add', sku: 'GSK-010', qty: 1 });
    await cart(made.id).applyAs(ada, { op: 'set_ship_to', address: berlin });
    expect(
      await cart(made.id).applyAs(ada, { op: 'set_shipping_option', option: 'express' }),
    ).toEqual({ ok: true });
    const c = (await state(made.id)).cart!;
    expect(c.shippingOption).toBe('express');
    expect(c.quote!.shippingOption).toBe('standard');
    expect(cartShippingOption(c)).toBe('standard');
    expect(c.issues).toContainEqual(
      expect.objectContaining({ kind: 'warning', code: 'shipping_option' }),
    );
    // A warning: it still submits, with the option it was charged for.
    const done = await cart(made.id).submitAs(ada);
    if (!done.ok) throw new Error(done.error);
    const order = ((await env.ORDER_AGENT.getByName(done.orderId).snapshot()) as OrderState).order!;
    expect(order.shippingOption).toBe('standard');
  });

  it('starts an order with the option the quote charged when none was chosen, and none for a flow without shipping', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const id = await openShipping();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'GSK-010', qty: 1 });
    await cart(id).applyAs(ada, { op: 'set_ship_to', address: berlin });
    const done = await cart(id).submitAs(ada);
    if (!done.ok) throw new Error(done.error);
    const order = ((await env.ORDER_AGENT.getByName(done.orderId).snapshot()) as OrderState).order!;
    expect(order.shippingOption).toBe('standard');

    // The B2B flow prices no shipping: no address needed, and its order gets none.
    const b2b = await open();
    await cart(b2b).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 1 });
    expect((await state(b2b)).cart!.quote!.shippingOptions).toEqual([]);
    expect(await cart(b2b).applyAs(ada, { op: 'set_shipping_option', option: 'standard' })).toEqual(
      { ok: false, error: 'This cart’s flow offers no shipping options.' },
    );
    const plain = await cart(b2b).submitAs(ada);
    if (!plain.ok) throw new Error(plain.error);
    const o = ((await env.ORDER_AGENT.getByName(plain.orderId).snapshot()) as OrderState).order!;
    expect(o.shippingOption).toBeUndefined();
    expect(o.meta).not.toHaveProperty('shipTo');
  });
});

describe('promotion codes on a cart', () => {
  it('takes a code off the price when the cart’s flow applies promotions, and refuses an unknown one', async () => {
    // The built-in B2B flow, which applies promotions between pricing and tax.
    const flow = { ...b2bOrderFlow(), id: 'test-cart-promos' };
    await publishFlow(db(), flow);
    await db()
      .insert(promotions)
      .values({
        id: 'promo_cart10',
        code: 'CART10',
        kind: 'pct',
        value: 10,
        createdAt: 0,
        updatedAt: 0,
      })
      .onConflictDoNothing();
    const made = await api().createCart({
      title: 'Promo cart',
      flowId: flow.id,
      customerId: 'cus_northwind',
      createdBy: 'usr_cart_ada',
    });
    if (!made.ok) throw new Error(made.error);
    const ada = staff(await who('operator', 'ada'));
    await cart(made.id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 10 });
    expect((await state(made.id)).cart!.quote!.subtotal).toBe(215);
    await cart(made.id).applyAs(ada, { op: 'promo_add', code: 'cart10' });
    const priced = (await state(made.id)).cart!;
    expect(priced.quote!.subtotal).toBe(193.5);
    expect(priced.issues.filter((i) => i.code === 'promotion')).toEqual([]);
    await cart(made.id).applyAs(ada, { op: 'promo_add', code: 'NOPE' });
    expect((await state(made.id)).cart!.issues).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        code: 'promotion',
        content: "NOPE isn't a promotion.",
      }),
    );
  });

  it('limits how many promotion codes one cart may try in an hour', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    for (let i = 0; i < PROMO_TRIES; i++) {
      await cart(id).applyAs(ada, { op: 'promo_add', code: `TRY${i}` });
      await cart(id).applyAs(ada, { op: 'promo_remove', code: `TRY${i}` });
    }
    expect(await cart(id).applyAs(ada, { op: 'promo_add', code: 'ONEMORE' })).toEqual({
      ok: false,
      error: 'Too many promotion codes tried on this cart. Try again later.',
    });
  });

  it('counts only codes actually tried, so someone who can’t edit can’t spend the tries', async () => {
    const id = await open();
    const vee = staff(await who('viewer', 'vee'));
    for (let i = 0; i <= PROMO_TRIES; i++)
      expect((await cart(id).applyAs(vee, { op: 'promo_add', code: `NO${i}` })).ok).toBe(false);
    const ada = staff(await who('operator', 'ada'));
    expect(await cart(id).applyAs(ada, { op: 'promo_add', code: 'MINE' })).toEqual({ ok: true });
  });

  it('keeps the codes, and says so when the cart’s flow never applies them', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 1 });
    expect(await cart(id).applyAs(ada, { op: 'promo_add', code: ' welcome15 ' })).toEqual({
      ok: true,
    });
    const s = await state(id);
    expect(s.cart!.promoCodes).toEqual(['WELCOME15']);
    expect(s.cart!.issues).toContainEqual(
      expect.objectContaining({ kind: 'warning', code: 'promotion', path: '$.promoCodes' }),
    );
    // A warning doesn't stop the cart from being submitted.
    expect(isQuoteCurrent(s.cart!)).toBe(true);
    await cart(id).applyAs(ada, { op: 'promo_remove', code: 'WELCOME15' });
    expect((await state(id)).cart!.issues.filter((i) => i.code === 'promotion')).toEqual([]);
  });
});

describe('the cart socket', () => {
  it('refuses a request without a live principal, and an unknown cart', async () => {
    const id = await open();
    expect((await upgrade(id, null)).status).toBe(401);
    const signedOut = { ...(await who('operator', 'gone')), session: 'sess_forged' };
    expect((await upgrade(id, signedOut)).status).toBe(401);
    expect((await upgrade('cart_nope', await who('operator', 'ada'))).status).toBe(404);
    // A principal signed for another path, and a path the SDK still routes to a cart.
    const ada = await who('operator', 'ada');
    expect((await upgrade(id, ada, { signFor: '/agents/order-agent/x' })).status).toBe(401);
    expect((await upgrade(id, null, { path: `//agents/cart-agent/${id}` })).status).toBe(401);
    expect((await upgrade(id, null, { path: `/agents//cart-agent/${id}` })).status).toBe(401);
  });

  it('refuses a viewer’s submit and a page writing state, and closes a socket whose sign-in ends', async () => {
    const id = await open();
    const vee = await who('viewer', 'vee2');
    const viewer = await socket(id, vee);
    expect((await viewer.call('submit')).result).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    expect((await viewer.call('cancel')).result).toMatchObject({ ok: false });
    viewer.send({ type: 'cf_agent_state', state: { cart: null, members: [], chat: [] } });
    await new Promise((r) => setTimeout(r, 100));
    expect((await state(id)).cart?.id).toBe(id);

    // Signed out while the page listens without calling anything: the next check closes it.
    await db().delete(sessions).where(eq(sessions.tokenHash, vee.session!));
    await cart(id).recheckConnections();
    await new Promise((r) => setTimeout(r, 100));
    expect(viewer.closed()).toBe(4401);
    expect((await state(id)).members.map((m) => m.name)).not.toContain('vee2');
  });

  it('lets a viewer read but not edit, and shows everyone who has it open', async () => {
    const id = await open();
    const viewer = await socket(id, await who('viewer', 'vee'));
    const op = await socket(id, await who('operator', 'opal'));

    expect(await viewer.call('apply', [{ op: 'add', sku: 'WID-100', qty: 1 }])).toMatchObject({
      success: true,
      result: { ok: false, error: "You can't change this cart." },
    });
    expect((await op.call('apply', [{ op: 'add', sku: 'WID-100', qty: 2 }])).result).toEqual({
      ok: true,
    });
    const s = await state(id);
    expect(s.cart!.lines).toEqual([expect.objectContaining({ sku: 'WID-100', qty: 2 })]);
    expect(s.members.map((m) => m.name).sort()).toEqual(['opal', 'vee']);
    // A page can't write state; it changes only through methods.
    viewer.close();
    op.close();
  });

  it('sets several quantities as one change, priced once, and refuses the lot when a line is gone', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 1 });
    await cart(id).applyAs(ada, { op: 'add', sku: 'GSK-010', qty: 1 });
    const before = (await state(id)).cart!;
    const [wid, gsk] = before.lines;
    const op = await socket(id, await who('operator', 'opal'));

    expect(
      (
        await op.call('apply', [
          {
            op: 'set_qtys',
            lines: [
              { lineId: wid!.id, qty: 10 },
              { lineId: gsk!.id, qty: 0 },
            ],
          },
        ])
      ).result,
    ).toEqual({ ok: true });
    const after = (await state(id)).cart!;
    // One version and one quote for the lot, as if one person made one change.
    expect(after.version).toBe(before.version + 1);
    expect(isQuoteCurrent(after)).toBe(true);
    expect(after.lines).toEqual([expect.objectContaining({ sku: 'WID-100', qty: 10 })]);
    expect(after.quote!.subtotal).toBe(215);
    // Every version the change made, as the people on the cart saw it: one, priced once.
    const changed = op.states().filter((s) => s.cart!.version > before.version);
    expect([...new Set(changed.map((s) => s.cart!.version))]).toEqual([after.version]);
    expect(
      changed.filter((s) => s.cart!.quote && s.cart!.quotedVersion === s.cart!.version),
    ).toHaveLength(1);

    // A line gone meanwhile refuses every change, and the cart stays as it was. A cart reuses a
    // removed line's id for the next line added, so this holds only while nothing has taken it.
    expect(after.lines.map((l) => l.id)).not.toContain(gsk!.id);
    expect(
      (
        await op.call('apply', [
          {
            op: 'set_qtys',
            lines: [
              { lineId: wid!.id, qty: 3 },
              { lineId: gsk!.id, qty: 3 },
            ],
          },
        ])
      ).result,
    ).toEqual({ ok: false, error: 'A line you chose is gone.' });
    const refused = (await state(id)).cart!;
    expect(refused.version).toBe(after.version);
    expect(refused.lines.map((l) => [l.sku, l.qty])).toEqual([['WID-100', 10]]);
    op.close();
  });

  it('keeps chat to its authors and pages history', async () => {
    const id = await open();
    const a = await socket(id, await who('viewer', 'ann'));
    const b = await socket(id, await who('viewer', 'ben'));
    const said = await a.call<{ ok: true; id: string }>('say', ['  Need these by Friday  ']);
    const msgId = said.result!.id;
    expect((await state(id)).chat).toEqual([
      expect.objectContaining({ id: msgId, authorName: 'ann', body: 'Need these by Friday' }),
    ]);
    expect((await b.call('edit', [msgId, 'mine now'])).result).toMatchObject({ ok: false });
    expect((await b.call('unsay', [msgId])).result).toMatchObject({ ok: false });
    expect((await a.call('edit', [msgId, 'By Thursday'])).result).toEqual({ ok: true });
    expect((await a.call('say', [' '])).result).toMatchObject({ ok: false });
    const history = await b.call<{ body: string }[]>('history');
    expect(history.result!.map((m) => m.body)).toEqual(['By Thursday']);
    expect((await a.call('unsay', [msgId])).result).toEqual({ ok: true });
    expect((await state(id)).chat).toEqual([]);
    a.close();
    b.close();
  });
});

/**
 * Records what the cart's agent writes from here on (SQL that changes something, storage puts and
 * deletes, and `setState`) until `stop` puts it back.
 */
async function watchWrites(id: string) {
  const writes: string[] = [];
  const spies = await runInDurableObject(cart(id), (agent, ctx) => {
    const sql = ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    return [
      vi.spyOn(sql, 'exec').mockImplementation(((q: string, ...b: unknown[]) => {
        if (/^\s*(insert|update|delete|replace|create|drop|alter)\b/i.test(q)) writes.push(q);
        return exec(q, ...b);
      }) as typeof sql.exec),
      vi.spyOn(ctx.storage, 'put').mockImplementation((async () => {
        writes.push('put');
      }) as never),
      vi.spyOn(ctx.storage, 'delete').mockImplementation((async () => {
        writes.push('delete');
        return false;
      }) as never),
      vi.spyOn(agent, 'setState').mockImplementation(() => {
        writes.push('setState');
      }),
    ];
  });
  return {
    writes,
    stop: () =>
      runInDurableObject(cart(id), () => {
        for (const s of spies) s.mockRestore();
      }),
  };
}

describe('typing on a cart', () => {
  it('tells the others who is typing, as they signed in, and never stores it', async () => {
    const id = await open();
    const ann = await socket(id, await who('operator', 'ann'));
    const ben = await socket(id, await who('viewer', 'ben'));
    // Both have the state their opening sent before anything is counted.
    await ann.call('whoami');
    await ben.call('whoami');
    const statesBefore = ben.states().length;
    const watched = await watchWrites(id);
    const before = Date.now();
    // Whatever a page passes, the notice names the socket's own person.
    expect((await ann.call('typing', ['Mallory', 'usr_cart_ben'])).result).toBe(true);
    await vi.waitFor(() => expect(ben.typings()).toHaveLength(1));
    expect(ben.typings()[0]).toEqual({
      type: 'cart_typing',
      memberId: 'usr_cart_ann',
      name: 'ann',
      until: expect.any(Number),
    });
    expect(ben.typings()[0]!.until).toBeGreaterThanOrEqual(before + CART_TYPING_MS);
    // A viewer may chat, so may say they are writing; neither hears their own.
    expect((await ben.call('typing')).result).toBe(true);
    await vi.waitFor(() => expect(ann.typings()).toHaveLength(1));
    expect(ann.typings()[0]).toMatchObject({ memberId: 'usr_cart_ben', name: 'ben' });
    await ann.call('whoami');
    await ben.call('whoami');
    expect(ann.typings().map((t) => t.memberId)).not.toContain('usr_cart_ann');
    expect(ben.typings().map((t) => t.memberId)).not.toContain('usr_cart_ben');

    // Sent, not stored: no SQL write, no storage, no state broadcast.
    await watched.stop();
    expect(watched.writes).toEqual([]);
    expect(ben.states()).toHaveLength(statesBefore);
    expect((await state(id)).chat).toEqual([]);
    ann.close();
    ben.close();
  });

  it('ignores a socket that says so again within the limit', async () => {
    const id = await open();
    const ann = await socket(id, await who('operator', 'ann'));
    const ben = await socket(id, await who('viewer', 'ben'));
    expect((await ann.call('typing')).result).toBe(true);
    for (let i = 0; i < 5; i++) expect((await ann.call('typing')).result).toBe(false);
    await ben.call('whoami');
    expect(ben.typings()).toHaveLength(1);
    // Another of the same person's tabs is its own socket, with its own limit.
    const again = await socket(id, await who('operator', 'ann'));
    expect((await again.call('typing')).result).toBe(true);
    await vi.waitFor(() => expect(ben.typings()).toHaveLength(2));
    for (const s of [ann, ben, again]) s.close();
  });

  it('ends when they send the message or leave', async () => {
    const id = await open();
    const ann = await socket(id, await who('operator', 'ann'));
    const ben = await socket(id, await who('viewer', 'ben'));
    await ann.call('typing');
    expect((await ann.call('say', ['Friday works'])).result).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(ben.typings()).toHaveLength(2));
    // A stop names no one: the page needs only the id.
    expect(ben.typings()[1]).toEqual({
      type: 'cart_typing',
      memberId: 'usr_cart_ann',
      name: '',
      until: 0,
    });
    // Sending resets the limit, so the next message's typing shows straight away.
    expect((await ann.call('typing')).result).toBe(true);
    // A message with no typing before it ends nothing.
    await ben.call('say', ['ok']);
    ann.close();
    await vi.waitFor(() => expect(ben.typings()).toHaveLength(4));
    expect(ben.typings().slice(2)).toEqual([
      expect.objectContaining({ memberId: 'usr_cart_ann', until: expect.any(Number) }),
      expect.objectContaining({ memberId: 'usr_cart_ann', name: '', until: 0 }),
    ]);
    expect(ann.typings()).toEqual([]);
    ben.close();
  });

  it('sends nothing for a call still being checked when its message went', async () => {
    const id = await open();
    const ann = await socket(id, await who('operator', 'ann'));
    const ben = await socket(id, await who('viewer', 'ben'));
    // Hold the typing call's check of who is calling (a D1 read for staff) while the message goes.
    await runInDurableObject(cart(id), (agent) => {
      const a = agent as unknown as { caller: (o?: object) => Promise<unknown> };
      const caller = a.caller.bind(agent);
      vi.spyOn(a, 'caller').mockImplementationOnce(async (o) => {
        await new Promise((r) => setTimeout(r, 300));
        return caller(o);
      });
    });
    const typing = ann.call('typing');
    expect((await ann.call('say', ['Sent before the check finished'])).result).toMatchObject({
      ok: true,
    });
    expect((await typing).result).toBe(false);
    await ben.call('whoami');
    expect(ben.typings()).toEqual([]);
    // And it left nothing behind: the next call goes out at once.
    expect((await ann.call('typing')).result).toBe(true);
    ann.close();
    ben.close();
  });

  it('refuses a socket whose sign-in ended, and tells no one', async () => {
    const id = await open();
    const vee = await who('viewer', 'vee3');
    const viewer = await socket(id, vee);
    const op = await socket(id, await who('operator', 'opal'));
    await db().delete(sessions).where(eq(sessions.tokenHash, vee.session!));
    const r = await viewer.call('typing');
    expect(r.success).toBe(false);
    // Nor when its socket closes: it never said it was typing.
    viewer.close();
    await new Promise((r) => setTimeout(r, 100));
    await op.call('whoami');
    expect(op.typings()).toEqual([]);
    op.close();
  });
});

describe('cart files', () => {
  const file = (id: string, cartId: string) => ({
    id,
    name: 'spec.pdf',
    type: 'application/pdf',
    size: 4,
    key: `carts/${cartId}/${id}`,
  });

  it('lists a file the web app stored, for whoever may change the cart', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    const vee = staff(await who('viewer', 'vee'));
    expect(await cartApi.attachToCart(id, file('att_1', id), vee)).toEqual({
      ok: false,
      error: "You can't change this cart.",
    });
    expect(
      await cartApi.attachToCart(id, { ...file('att_2', id), key: 'carts/cart_x/att_2' }, ada),
    ).toEqual({
      ok: false,
      error: 'That file isn’t this cart’s.',
    });
    expect(
      await cartApi.attachToCart(id, { ...file('att_3', id), type: 'text/html' }, ada),
    ).toMatchObject({
      ok: false,
    });
    expect(await cartApi.attachToCart(id, file('att_1', id), ada)).toEqual({ ok: true });
    expect((await state(id)).attachments).toEqual([
      expect.objectContaining({ id: 'att_1', by: { id: ada.id, name: 'ada' } }),
    ]);
    expect(await cartApi.attachToCart('cart_nope', file('att_1', 'cart_nope'), ada)).toMatchObject({
      ok: false,
    });
  });

  it('removes a file for who added it or an operator, and deletes it', async () => {
    const id = await open();
    const ann = await who('operator', 'ann2');
    await env.DOCS.put(`carts/${id}/att_9`, '%PDF');
    expect(await cartApi.attachToCart(id, file('att_9', id), staff(ann))).toEqual({ ok: true });
    const viewer = await socket(id, await who('viewer', 'vic'));
    expect((await viewer.call('detach', ['att_9'])).result).toMatchObject({ ok: false });
    const owner = await socket(id, ann);
    expect((await owner.call('detach', ['att_9'])).result).toEqual({ ok: true });
    expect((await state(id)).attachments).toEqual([]);
    expect(await env.DOCS.get(`carts/${id}/att_9`)).toBeNull();
    viewer.close();
    owner.close();
  });
});

describe('submitting a cart', () => {
  it('starts one order of the cart’s flow from the quote, and ends the cart', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    const viewer = staff(await who('viewer', 'vee'));
    await cart(id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 10 });

    expect(await cart(id).submitAs(viewer)).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    const done = await cart(id).submitAs(ada);
    if (!done.ok) throw new Error(done.error);
    const s = await state(id);
    expect(s.cart).toMatchObject({ status: 'submitted', orderId: done.orderId });
    expect(await cart(id).submitAs(ada)).toEqual({ ok: false, error: 'The cart is submitted.' });
    expect(await cart(id).applyAs(ada, { op: 'clear' })).toEqual({
      ok: false,
      error: 'The cart is submitted.',
    });

    const order = await db().select().from(orders).where(eq(orders.id, done.orderId)).get();
    expect(order).toMatchObject({
      flowId: 'tpl-b2b-order',
      customerId: 'cus_northwind',
      externalId: id,
      startedBy: ada.id,
      channel: 'manual',
    });
    const row = await db().select().from(carts).where(eq(carts.id, id)).get();
    expect(row).toMatchObject({ status: 'submitted', orderId: done.orderId });
  });

  it('cancels once, and only for an operator', async () => {
    const id = await open(null);
    const ada = staff(await who('operator', 'ada'));
    expect(await cart(id).cancelAs(staff(await who('viewer', 'vee')))).toMatchObject({ ok: false });
    expect(await cart(id).cancelAs(ada)).toEqual({ ok: true });
    expect(await cart(id).cancelAs(ada)).toEqual({ ok: false, error: 'The cart is canceled.' });
  });
});

describe('staff carts over EngineApi (the REST API)', () => {
  it('acts only as an actor the web app signed for this cart', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    const refused = { ok: false, error: 'This call must name who is acting.' };
    // Unsigned, or signed for another cart: whoever else held the binding couldn't act as anyone.
    expect(await api().changeCart(id, { op: 'clear' }, 'a1.forged.sig')).toEqual(refused);
    expect(
      await api().changeCart(id, { op: 'clear' }, await signedActor(ada, 'cart:cart_other')),
    ).toEqual(refused);
    expect(await api().cancelCart(id, JSON.stringify(ada))).toEqual(refused);
    expect(await api().submitCart(id, ada as never)).toEqual(refused);
    expect(
      await api().attachToCart(
        id,
        { id: 'att_x', name: 'x.pdf', type: 'application/pdf', size: 1, key: `carts/${id}/att_x` },
        await signedActor(ada, 'cart:cart_other'),
      ),
    ).toEqual(refused);
  });

  it('applies an op as the caller and answers with the cart priced again', async () => {
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    const r = await cartApi.changeCart(id, { op: 'add', sku: 'WID-100', qty: 2 }, ada);
    if (!r.ok) throw new Error(r.error);
    expect(r.cart).toMatchObject({ id, quoteCurrent: true, notReady: null });
    expect(r.cart.lines).toEqual([expect.objectContaining({ sku: 'WID-100', qty: 2 })]);
    expect(r.cart.quote?.subtotal).toBe(43);
    // The view leaves out what stays on the cart's page.
    expect(r.cart).not.toHaveProperty('external');
    expect(r.cart).not.toHaveProperty('chat');
  });

  it('refuses a viewer, a guest, a malformed op, an unknown cart and an external one', async () => {
    const id = await open();
    const viewer = staff(await who('viewer', 'vee'));
    expect(await cartApi.changeCart(id, { op: 'clear' }, viewer)).toEqual({
      ok: false,
      error: "You can't change this cart.",
    });
    expect(await cartApi.submitCart(id, viewer)).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    expect((await cartApi.cancelCart(id, viewer)).ok).toBe(false);
    // Typed as staff, but the binding carries whatever its caller sends.
    const guest = { kind: 'guest', id: 'guest:x', name: 'X' } as never;
    expect(await cartApi.changeCart(id, { op: 'clear' }, guest)).toMatchObject({ ok: false });
    expect(await cartApi.submitCart(id, guest)).toMatchObject({ ok: false });
    const ada = staff(await who('operator', 'ada'));
    expect(await cartApi.changeCart(id, { op: 'add', sku: 'WID-100' } as never, ada)).toEqual({
      ok: false,
      error: 'That is not a cart change.',
    });
    expect(await cartApi.changeCart('cart_nope', { op: 'clear' }, ada)).toMatchObject({
      ok: false,
      notFound: true,
    });
    const ext = await createCart(
      env,
      { title: 'Punchout', flowId: 'tpl-b2b-order', createdBy: 'plugin:example' },
      {
        pluginId: 'example',
        sessionRef: `s-${Date.now()}`,
        expiresAt: Date.now() + 3_600_000,
        idleMs: null,
        returnUrl: 'https://buyer.example/return',
        frameOrigins: [],
        buyer: { id: 'buyer@example.com', name: 'Buyer' },
      },
    );
    if (!ext.ok) throw new Error(ext.error);
    for (const r of [
      await cartApi.changeCart(ext.id, { op: 'lock' }, ada),
      await cartApi.submitCart(ext.id, ada),
      await cartApi.cancelCart(ext.id, ada),
    ])
      expect(r).toMatchObject({ ok: false, notFound: true });
    expect((await state(ext.id)).cart?.status).toBe('open');
  });

  it('submits as the caller once, and cancels only a cart that has not ended', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const id = await open();
    const ada = staff(await who('operator', 'ada'));
    expect(await cartApi.submitCart(id, ada)).toEqual({
      ok: false,
      error: 'Add at least one line.',
    });
    await cartApi.changeCart(id, { op: 'add', sku: 'WID-100', qty: 1 }, ada);
    const done = await cartApi.submitCart(id, ada);
    if (!done.ok) throw new Error(done.error);
    const order = await db().select().from(orders).where(eq(orders.id, done.orderId)).get();
    expect(order).toMatchObject({ startedBy: ada.id, externalId: id });
    // A replay starts nothing more.
    expect(await cartApi.submitCart(id, ada)).toEqual({
      ok: false,
      error: 'The cart is submitted.',
    });
    expect(await cartApi.cancelCart(id, ada)).toEqual({
      ok: false,
      error: 'The cart is submitted.',
    });

    const other = await open(null);
    const canceled = await cartApi.cancelCart(other, ada);
    expect(canceled).toMatchObject({ ok: true, cart: { status: 'canceled' } });
  });
});

describe('orders started from outside the engine', () => {
  it('drop the engine’s own cart and UCP marks from meta', async () => {
    const { orderId } = await api().startOrder({
      flowId: 'tpl-b2b-order',
      input: {
        model: 'b2b',
        channel: 'api',
        currency: 'USD',
        customerId: 'cus_contoso',
        lines: [{ sku: 'WID-200', qty: 1 }],
        meta: { ucp: { platformId: 'ucp_forged' }, cart: { id: 'cart_forged' }, po: 'PO-1' },
      },
    });
    const order = ((await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState).order!;
    expect(order.meta).toEqual({ po: 'PO-1' });
    await env.ORDER_AGENT.getByName(orderId).cancel('Cleanup');
  });
});

describe('cart retention', () => {
  it('clears an ended cart’s chat, files and ship-to after the retention, once, and keeps its lines', async () => {
    const id = await open();
    const ada = await who('operator', 'ada');
    const ws = await socket(id, ada);
    await cart(id).applyAs(staff(ada), { op: 'add', sku: 'WID-100', qty: 1 });
    await cart(id).applyAs(staff(ada), {
      op: 'set_ship_to',
      address: {
        name: 'Ann',
        line1: '9 Dock Rd',
        city: 'Leeds',
        postalCode: 'LS1 4AP',
        country: 'GB',
      },
    });
    await ws.call('say', ['Ann at ann@northwind.example wants these Friday']);
    await env.DOCS.put(`carts/${id}/att_r1`, '%PDF');
    await cartApi.attachToCart(
      id,
      { id: 'att_r1', name: 'po.pdf', type: 'application/pdf', size: 4, key: `carts/${id}/att_r1` },
      staff(ada),
    );
    ws.close();
    await cart(id).cancelAs(staff(ada));
    // Not yet past the retention: kept.
    expect(await purgeEndedCarts(env)).toBe(0);
    const later = Date.now() + RETENTION.endedCartsMs + 1;
    expect(await purgeEndedCarts(env, later)).toBeGreaterThanOrEqual(1);
    const s = await state(id);
    expect(s.chat).toEqual([]);
    expect(s.attachments).toEqual([]);
    expect(s.cart!.lines).toEqual([expect.objectContaining({ sku: 'WID-100', qty: 1 })]);
    expect(s.cart!.shipTo).toBeNull();
    expect(await env.DOCS.get(`carts/${id}/att_r1`)).toBeNull();
    const row = await db().select().from(carts).where(eq(carts.id, id)).get();
    expect(row?.purgedAt).toEqual(expect.any(Number));
    // Done once: the same cart isn't swept again.
    const again = await purgeEndedCarts(env, later);
    expect((await db().select().from(carts).where(eq(carts.id, id)).get())?.purgedAt).toBe(
      row?.purgedAt,
    );
    expect(again).toBeGreaterThanOrEqual(0);
  });
});
