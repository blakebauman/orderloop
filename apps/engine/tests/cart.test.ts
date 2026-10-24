import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  b2bOrderFlow,
  type CartState,
  isQuoteCurrent,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
} from '@orderloop/core';
import { carts, createDb, orders, promotions, publishFlow, sessions, users } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { signed } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
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
  let closedWith: number | null = null;
  ws.addEventListener('close', (e) => {
    closedWith = e.code;
  });
  const errors: string[] = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
    if (m.type === 'cf_agent_state') last = m.state as CartState;
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

describe('promotion codes on a cart', () => {
  it('takes a code off the price when the cart’s flow applies promotions, and refuses an unknown one', async () => {
    // The B2B flow with Apply promotions between pricing and tax.
    const base = b2bOrderFlow();
    const flow = {
      ...base,
      id: 'test-cart-promos',
      nodes: [
        ...base.nodes,
        {
          id: 'promo',
          type: 'commerce.discount',
          label: 'Promotions',
          config: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        ...base.edges.map((e) =>
          e.source === 'price' && e.target === 'tax' ? { ...e, target: 'promo' } : e,
        ),
        { id: 'e-promo-tax', source: 'promo', target: 'tax' },
      ],
    };
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
