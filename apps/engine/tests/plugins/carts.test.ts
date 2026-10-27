import { applyD1Migrations, introspectWorkflow, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type CartGuest,
  type CartState,
  type ExternalCartInput,
  MAX_EXTERNAL_CART_MS,
  PRINCIPAL_HEADER,
  signCartGuest,
  signPrincipal,
  subjectTarget,
  verifyWebhook,
} from '@orderloop/core';
import {
  auditEvents,
  carts,
  createDb,
  orders,
  sessions,
  users,
  webhookDeliveries,
  webhookSubscriptions,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import worker from '../../src/index';
import { PluginHost } from '../../src/plugin-api';
import { pluginStatuses } from '../../src/plugins';
import { indexCartBuyers } from '../../src/retention';
import { eraseDataSubject, exportDataSubject } from '../../src/subjects';
import { signedActor } from '../principal';

const testEnv = env as Env & { EXAMPLE_DB: D1Database; TEST_EXAMPLE_MIGRATIONS: D1Migration[] };
const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
/** The host API as the plugin `id` would reach it: the binding's props name the caller. */
const hostFor = (id?: string) =>
  new PluginHost(
    { waitUntil() {}, passThroughOnException() {}, props: id ? { id } : undefined } as never,
    env,
  );
const cartAgent = (id: string) => env.CART_AGENT.getByName(id);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

beforeAll(async () => {
  await applyD1Migrations(testEnv.EXAMPLE_DB, testEnv.TEST_EXAMPLE_MIGRATIONS);
  await ensureTemplates(env);
});

const input = (o: Partial<ExternalCartInput> = {}): ExternalCartInput => ({
  sessionRef: `cookie-${crypto.randomUUID()}`,
  title: 'Punchout from Ariba',
  flowId: 'tpl-b2b-order',
  customerId: 'cus_northwind',
  buyer: { id: 'ann@northwind.example', name: 'Ann Buyer' },
  returnUrl: 'https://buyer.example/punchout/return',
  frameOrigins: ['https://buyer.example'],
  expiresAt: Date.now() + 3_600_000,
  ...o,
});

async function open(o: Partial<ExternalCartInput> = {}) {
  const r = await hostFor('example').openExternalCart(input(o));
  if (!r.ok) throw new Error(r.error);
  const [, , , cartId, token] = r.cart.startPath.split('/');
  return { ...r.cart, cartId: cartId!, token: token! };
}

/** The cart's socket as its buyer, as the web app would sign it after redeeming a start link. */
async function guestSocket(
  cartId: string,
  guest: CartGuest,
  path = `/agents/cart-agent/${cartId}`,
) {
  const headers = new Headers({ Upgrade: 'websocket' });
  headers.set(
    PRINCIPAL_HEADER,
    await signCartGuest((env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!, guest, path),
  );
  const res = await worker.fetch(new Request(`http://engine${path}`, { headers }), env);
  const ws = res.webSocket;
  if (!ws) return { status: res.status } as { status: number; call?: undefined };
  ws.accept();
  const pending = new Map<string, (m: { result?: unknown; error?: string }) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
  });
  let n = 0;
  return {
    status: 101,
    call: <T = unknown>(method: string, args: unknown[] = []) =>
      new Promise<{ result?: T; error?: string }>((resolve) => {
        const id = `c${++n}`;
        pending.set(id, resolve as never);
        ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
      }),
  };
}

describe('the plugin host API', () => {
  it('refuses a plugin without the capability granted, and a call with no plugin', async () => {
    expect(await hostFor('fixture-carrier').openExternalCart(input())).toEqual({
      ok: false,
      error: 'This plugin may not open carts here.',
    });
    expect(await hostFor(undefined).openExternalCart(input())).toMatchObject({ ok: false });
    expect(
      await hostFor('fixture-carrier').startOrder({
        key: 'k',
        flowId: 'tpl-b2b-order',
        input: { model: 'b2b', lines: [{ sku: 'WID-100', qty: 1 }] },
      }),
    ).toEqual({ ok: false, error: 'This plugin may not start orders here.' });
  });

  it('opens one cart per session, prefilled and priced, with a fresh start link each time', async () => {
    const sessionRef = `cookie-${crypto.randomUUID()}`;
    const a = await open({ sessionRef, lines: [{ sku: 'WID-100', qty: 4 }] });
    const b = await open({ sessionRef });
    expect(b.cartId).toBe(a.cartId);
    expect(b.startUrl).toBe(`https://app.orderloop.test${b.startPath}`);
    expect(b.token).not.toBe(a.token);
    const row = await db().select().from(carts).where(eq(carts.id, a.cartId)).get();
    expect(row).toMatchObject({ pluginId: 'example', sessionRef, createdBy: 'plugin:example' });
    const cart = await hostFor('example').getCart(a.cartId);
    expect(cart).toMatchObject({ sessionRef, status: 'open' });
    expect(cart!.quote!.lines[0]).toMatchObject({ sku: 'WID-100', qty: 4, unitPrice: 21.5 });
  });

  it('refuses unsafe or impossible carts', async () => {
    const refused = async (o: Partial<ExternalCartInput>) => {
      const r = await hostFor('example').openExternalCart(input(o));
      return r.ok ? null : r.error;
    };
    expect(await refused({ returnUrl: 'http://buyer.example/return' })).toMatch(/https/);
    expect(await refused({ returnUrl: 'https://u:p@buyer.example/' })).toMatch(/credentials/);
    expect(await refused({ frameOrigins: ['https://buyer.example/path'] })).toMatch(/origins/);
    expect(await refused({ expiresAt: Date.now() + 48 * 3_600_000 })).toMatch(/24 hours/);
    expect(await refused({ flowId: 'flow_nope' })).toMatch(/no published version/);
    expect(await refused({ customerId: 'cus_nope' })).toMatch(/No such customer/);
    expect(await refused({ lines: [{ sku: 'X', qty: 0 }] })).toMatch(/whole quantity/);
    // Never back to the deployment itself, where a post would carry someone's session.
    expect(await refused({ returnUrl: 'https://app.orderloop.test/api/v1/orders' })).toMatch(
      /buyer’s system/,
    );
    expect(await refused({ returnUrl: 'https://catalog.app.orderloop.test/x' })).toMatch(
      /buyer’s system/,
    );
    expect(await refused({ returnUrl: 'https://app.orderloop.test./x' })).toMatch(/buyer’s system/);
    expect(await refused({ returnUrl: 'https://eu.app.orderloop.test/x' })).toMatch(
      /buyer’s system/,
    );
    expect(await refused({ sessionRef: ['x'] as unknown as string })).toMatch(/sessionRef/);
    expect(
      await refused({ buyer: { id: 1, name: 'A' } as unknown as { id: string; name: string } }),
    ).toMatch(/buyer/);
  });

  it('checks a cart as opening it would, without opening, finding or waking one', async () => {
    const count = async () => (await db().select({ id: carts.id }).from(carts).all()).length;
    const before = await count();
    const checked = (o: Partial<ExternalCartInput>) =>
      hostFor('example').checkExternalCart(input(o));
    expect(await checked({})).toEqual({
      ok: true,
      problems: { input: null, flow: null, customer: null },
    });
    // Every problem at once, each as opening the cart would refuse it.
    expect(
      await checked({
        flowId: 'flow_nope',
        customerId: 'cus_nope',
        returnUrl: 'https://app.orderloop.test/x',
      }),
    ).toEqual({
      ok: true,
      problems: {
        input: 'returnUrl must be the buyer’s system, not this one',
        flow: 'That flow has no published version.',
        customer: 'No such customer.',
      },
    });
    expect(await checked({ customerId: null })).toMatchObject({ problems: { customer: null } });
    expect(await checked({ flowId: 7 as unknown as string })).toMatchObject({
      problems: { input: 'title and flowId are strings', flow: 'A flow is required.' },
    });
    // The session it names is never opened, so opening it later makes a new cart.
    const sessionRef = `cookie-${crypto.randomUUID()}`;
    await checked({ sessionRef });
    expect(await count()).toBe(before);
    expect(
      await db().select().from(carts).where(eq(carts.sessionRef, sessionRef)).get(),
    ).toBeUndefined();
    // Not without the capability, and nothing that isn't an input.
    expect(await hostFor('fixture-carrier').checkExternalCart(input())).toEqual({
      ok: false,
      error: 'This plugin may not open carts here.',
    });
    expect(await hostFor(undefined).checkExternalCart(input())).toMatchObject({ ok: false });
    expect(
      await hostFor('example').checkExternalCart(null as unknown as ExternalCartInput),
    ).toEqual({ ok: false, error: 'That is not a cart to check.' });
    const real = (await pluginStatuses(env, true)).find((p) => p.id === 'example')!.manifest!;
    const withdrawn = new PluginHost(
      { waitUntil() {}, passThroughOnException() {}, props: { id: 'example' } } as never,
      {
        ...env,
        PLUGIN_EXAMPLE: { fetch() {}, manifest: async () => real },
        PLUGIN_GRANTS: JSON.stringify({ example: { capabilities: ['orders:start'] } }),
      } as unknown as Env,
    );
    expect(await withdrawn.checkExternalCart(input())).toEqual({
      ok: false,
      error: 'This plugin may not open carts here.',
    });
    expect(await count()).toBe(before);
  });

  it('shows a plugin only the carts it opened', async () => {
    const staff = await api().createCart({
      title: 'Staff cart',
      flowId: 'tpl-b2b-order',
      createdBy: 'usr_1',
    });
    if (!staff.ok) throw new Error(staff.error);
    expect(await hostFor('example').getCart(staff.id)).toBeNull();
  });

  it('starts an order once per key, in its own namespace, saying which plugin started it', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const req = {
      key: `po-${crypto.randomUUID()}`,
      flowId: 'tpl-b2b-order',
      input: {
        model: 'b2b' as const,
        channel: 'edi' as const,
        customerId: 'cus_northwind',
        externalId: 'PO-1001',
        lines: [{ sku: 'WID-100', qty: 2 }],
      },
    };
    const first = await hostFor('example').startOrder(req);
    if (!first.ok) throw new Error(first.error);
    expect(await hostFor('example').startOrder(req)).toEqual({
      ok: true,
      orderId: first.orderId,
      replayed: true,
    });
    expect(
      await hostFor('example').startOrder({ ...req, input: { ...req.input, externalId: 'PO-2' } }),
    ).toEqual({ ok: false, error: 'That key already started a different order.' });
    const order = await db().select().from(orders).where(eq(orders.id, first.orderId)).get();
    expect(order).toMatchObject({ startedBy: 'plugin:example', externalId: 'PO-1001' });
    const audited = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, first.orderId))
      .all();
    expect(audited.map((a) => [a.action, a.actorId])).toEqual([
      ['order.started', 'plugin:example'],
    ]);
    expect(order!.idempotencyKey).toBe(`plugin:example:${req.key}`);
    expect(
      (await hostFor('example').startOrder({ ...req, key: '' })) as { ok: boolean },
    ).toMatchObject({ ok: false });
  });

  it('cancels only an order it started, by its key, once', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const key = `po-${crypto.randomUUID()}`;
    const started = await hostFor('example').startOrder({
      key,
      flowId: 'tpl-b2b-order',
      input: { model: 'b2b', customerId: 'cus_northwind', lines: [{ sku: 'WID-100', qty: 1 }] },
    });
    if (!started.ok) throw new Error(started.error);
    expect(await hostFor('fixture-carrier').cancelOrder({ key, reason: 'x' })).toMatchObject({
      ok: false,
    });
    expect(await hostFor('example').cancelOrder({ key: 'never', reason: 'x' })).toEqual({
      ok: false,
      error: 'No order was started under that key.',
    });
    const first = await hostFor('example').cancelOrder({ key, reason: 'Buyer withdrew the PO' });
    expect(first).toMatchObject({ ok: true, orderId: started.orderId });
    expect(['cancelled', 'finished']).toContain((first as { outcome: string }).outcome);
    if ((first as { outcome: string }).outcome === 'cancelled')
      expect(await hostFor('example').cancelOrder({ key, reason: 'again' })).toEqual({
        ok: true,
        orderId: started.orderId,
        outcome: 'cancelled',
      });
  });

  it('answers where an order it started is, and only one it started', async () => {
    const key = `po-${crypto.randomUUID()}`;
    const started = await hostFor('example').startOrder({
      key,
      flowId: 'tpl-b2b-order',
      input: { model: 'b2b', customerId: 'cus_northwind', lines: [{ sku: 'WID-100', qty: 1 }] },
    });
    if (!started.ok) throw new Error(started.error);
    const live = await hostFor('example').orderStatus({ key });
    expect(live).toMatchObject({ ok: true, orderId: started.orderId });
    const unknown = { ok: false, error: 'No order was started under that key.' };
    expect(await hostFor('example').orderStatus({ key: 'never' })).toEqual(unknown);
    expect(await hostFor('fixture-carrier').orderStatus({ key })).toMatchObject({ ok: false });
    expect(await hostFor('example').orderStatus({ key: '' })).toMatchObject({ ok: false });
    await hostFor('example').cancelOrder({ key, reason: 'Buyer withdrew the PO' });
    const after = await hostFor('example').orderStatus({ key });
    expect(after).toMatchObject({ ok: true, orderId: started.orderId, ended: true });
    expect(['cancelled', 'completed', 'declined', 'failed', 'rolled_back']).toContain(
      (after as { status: string }).status,
    );
  });

  it('refuses a cancel to a plugin that may start orders but not cancel them', async () => {
    const key = `po-${crypto.randomUUID()}`;
    const req = {
      key,
      flowId: 'tpl-b2b-order',
      input: {
        model: 'b2b' as const,
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 1 }],
      },
    };
    const started = await hostFor('example').startOrder(req);
    if (!started.ok) throw new Error(started.error);
    // The example as a deployment would run it with `orders:start` alone: declared and granted.
    const real = (await pluginStatuses(env, true)).find((p) => p.id === 'example')!.manifest!;
    const startOnly = (grant: string[], capabilities = ['carts:external', 'orders:start']) =>
      new PluginHost(
        { waitUntil() {}, passThroughOnException() {}, props: { id: 'example' } } as never,
        {
          ...env,
          PLUGIN_EXAMPLE: { fetch() {}, manifest: async () => ({ ...real, capabilities }) },
          PLUGIN_GRANTS: JSON.stringify({ example: { capabilities: grant } }),
        } as unknown as Env,
      );
    const refused = { ok: false, error: 'This plugin may not cancel orders here.' };
    const host = startOnly(['carts:external', 'orders:start']);
    // It still starts orders (this key's, replayed), but can't call one off.
    expect(await host.startOrder(req)).toEqual({
      ok: true,
      orderId: started.orderId,
      replayed: true,
    });
    expect(await host.cancelOrder({ key, reason: 'x' })).toEqual(refused);
    // A grant its manifest doesn't ask for gives it nothing either.
    expect(
      await startOnly(['carts:external', 'orders:start', 'orders:cancel']).cancelOrder({
        key,
        reason: 'x',
      }),
    ).toEqual(refused);
    expect((await api().snapshot(started.orderId))?.status).not.toBe('cancelled');
    // It reads the order it started; one that may not start orders reads none.
    expect(await host.orderStatus({ key })).toMatchObject({ ok: true, orderId: started.orderId });
    expect(await startOnly(['carts:external'], ['carts:external']).orderStatus({ key })).toEqual({
      ok: false,
      error: 'This plugin may not start orders here.',
    });
    // With both, the same call cancels it.
    expect(await hostFor('example').cancelOrder({ key, reason: 'Buyer withdrew the PO' })).toEqual({
      ok: true,
      orderId: started.orderId,
      outcome: 'cancelled',
    });
  });

  it('answers cancelled to a cancel that arrives while another is under way', async () => {
    const key = `po-${crypto.randomUUID()}`;
    const started = await hostFor('example').startOrder({
      key,
      flowId: 'tpl-b2b-order',
      input: { model: 'b2b', customerId: 'cus_northwind', lines: [{ sku: 'WID-100', qty: 1 }] },
    });
    if (!started.ok) throw new Error(started.error);
    // Both read the order live; the agent refuses the second while the first is cancelling it.
    const both = await Promise.all([
      hostFor('example').cancelOrder({ key, reason: 'Buyer withdrew the PO' }),
      hostFor('example').cancelOrder({ key, reason: 'Buyer withdrew the PO' }),
    ]);
    expect(both).toEqual([
      { ok: true, orderId: started.orderId, outcome: 'cancelled' },
      { ok: true, orderId: started.orderId, outcome: 'cancelled' },
    ]);
    expect((await api().snapshot(started.orderId))?.status).toBe('cancelled');
  });

  it('keeps the core’s meta keys to the core, and refuses a currency with no rate', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const r = await hostFor('example').startOrder({
      key: `po-${crypto.randomUUID()}`,
      flowId: 'tpl-b2b-order',
      input: {
        model: 'b2b',
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 1 }],
        meta: {
          ucp: { platformId: 'ucp_x', checkoutId: 'chk_x', origin: 'https://x.test' },
          cart: { id: 'cart_x' },
          plugin: { id: 'fixture-carrier' },
          po: 'PO-7',
        },
      },
    });
    if (!r.ok) throw new Error(r.error);
    const snap = await api().snapshot(r.orderId);
    expect(snap?.order?.meta).toMatchObject({ po: 'PO-7', plugin: { id: 'example' } });
    expect(snap?.order?.meta).not.toHaveProperty('ucp');
    expect(snap?.order?.meta).not.toHaveProperty('cart');
    expect(
      await hostFor('example').startOrder({
        key: `po-${crypto.randomUUID()}`,
        flowId: 'tpl-b2b-order',
        input: { model: 'b2b', currency: 'XAU', lines: [{ sku: 'WID-100', qty: 1 }] },
      }),
    ).toEqual({ ok: false, error: 'Unsupported currency XAU; there is no exchange rate for it' });
  });
});

describe('an external cart’s buyer', () => {
  it('redeems a start link once', async () => {
    const c = await open();
    const guest = await cartAgent(c.cartId).redeemStart(c.token);
    expect(guest).toEqual({
      cartId: c.cartId,
      id: 'guest:ann@northwind.example',
      name: 'Ann Buyer',
    });
    expect(await cartAgent(c.cartId).redeemStart(c.token)).toBeNull();
    expect(await cartAgent(c.cartId).redeemStart('nope')).toBeNull();
  });

  it('edits only their own cart, and sends it back through the plugin that opened it', async () => {
    const c = await open({ lines: [{ sku: 'WID-100', qty: 4 }] });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const other = await open();
    // A buyer signed for one cart is refused at another's.
    expect(
      (await guestSocket(other.cartId, guest, `/agents/cart-agent/${other.cartId}`)).status,
    ).toBe(401);

    const ws = await guestSocket(c.cartId, guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    expect((await ws.call('apply', [{ op: 'add', sku: 'WID-100', qty: 1 }])).result).toEqual({
      ok: true,
    });
    expect((await ws.call('apply', [{ op: 'lock' }])).result).toEqual({
      ok: false,
      error: 'Only staff can do that.',
    });
    expect((await ws.call('submit')).result).toMatchObject({ ok: false });
    const said = await ws.call<{ ok: boolean }>('say', ['Is 5 enough?']);
    expect(said.result).toMatchObject({ ok: true });
    const state = (await api().cartSnapshot(c.cartId)) as CartState;
    expect(state.chat.at(-1)).toMatchObject({ authorName: 'Ann Buyer', body: 'Is 5 enough?' });
    expect(state.members).toEqual([
      { id: 'guest:ann@northwind.example', name: 'Ann Buyer', kind: 'guest' },
    ]);

    const sent = await ws.call<{ ok: true; url: string; fields: Record<string, string> }>(
      'transfer',
    );
    expect(sent.result).toEqual({
      ok: true,
      url: 'https://buyer.example/punchout/return',
      fields: { cart: c.cartId, session: expect.any(String), 'line[1]': 'WID-100x5' },
    });
    expect((await api().cartSnapshot(c.cartId))?.cart?.status).toBe('returned');
    expect((await ws.call('returnForm')).result).toEqual({
      url: sent.result!.url,
      fields: sent.result!.fields,
    });
    expect((await ws.call('transfer')).result).toEqual({
      ok: false,
      error: 'The cart is returned.',
    });
    // A returned session can't be opened again.
    expect(
      await hostFor('example').openExternalCart(
        input({ sessionRef: (await hostFor('example').getCart(c.cartId))!.sessionRef }),
      ),
    ).toEqual({ ok: false, error: 'That session’s cart is returned.' });
  });

  it('is announced once as returned, to subscribers and to a plugin that asked, without the buyer', async () => {
    const received: { body: string; signature: string | null }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      received.push({
        body: String(init?.body),
        signature: new Headers(init?.headers).get('x-orderloop-signature'),
      });
      return new Response('ok');
    });
    await db().insert(webhookSubscriptions).values({
      id: 'whs_returns',
      url: 'https://hooks.example/returns',
      secret: 'whsec_returns',
      events: '["cart.returned"]',
      createdAt: Date.now(),
    });
    try {
      const c = await open({ lines: [{ sku: 'WID-100', qty: 2 }] });
      const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
      const ws = await guestSocket(c.cartId, guest);
      if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
      expect((await ws.call<{ ok: boolean }>('transfer')).result).toMatchObject({ ok: true });
      expect((await ws.call('transfer')).result).toMatchObject({ ok: false });

      const rows = async () =>
        db().select().from(webhookDeliveries).where(eq(webhookDeliveries.orderId, c.cartId));
      const end = Date.now() + 30_000;
      while (Date.now() < end && (await rows()).filter((r) => r.status === 'delivered').length < 2)
        await new Promise((r) => setTimeout(r, 100));
      expect((await rows()).map((r) => [r.subscriptionId, r.event, r.status]).sort()).toEqual([
        ['plugin:example', 'cart.returned', 'delivered'],
        ['whs_returns', 'cart.returned', 'delivered'],
      ]);
      const sent = received.filter((r) => JSON.parse(r.body).cartId === c.cartId);
      expect(sent).toHaveLength(1);
      expect(await verifyWebhook('whsec_returns', sent[0]!.body, sent[0]!.signature)).toMatchObject(
        {
          ok: true,
        },
      );
      expect(JSON.parse(sent[0]!.body)).toMatchObject({
        event: 'cart.returned',
        cartId: c.cartId,
        orderId: null,
        data: {
          cart: {
            status: 'returned',
            source: 'external',
            pluginId: 'example',
            lines: [{ sku: 'WID-100', qty: 2 }],
          },
        },
      });
      for (const personal of ['ann@northwind.example', 'Ann Buyer', 'buyer.example'])
        expect(sent[0]!.body).not.toContain(personal);
      // The plugin recorded it once, under the cart.
      const got = await testEnv.EXAMPLE_DB.prepare(
        'SELECT event, order_id FROM deliveries WHERE order_id = ?',
      )
        .bind(c.cartId)
        .all();
      expect(got.results).toEqual([{ event: 'cart.returned', order_id: c.cartId }]);
    } finally {
      vi.restoreAllMocks();
      await db().delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, 'whs_returns'));
    }
  });

  it('goes back without a ship-to on a flow that prices shipping: the buyer’s PO says where', async () => {
    const c = await open({ flowId: 'tpl-storefront-order', lines: [{ sku: 'GSK-010', qty: 2 }] });
    const before = (await api().cartSnapshot(c.cartId))!.cart!;
    expect(before.quote).toMatchObject({ ships: true });
    expect(before.quote!.shippingOptions.length).toBeGreaterThan(0);
    expect(before.shipTo).toBeNull();
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const ws = await guestSocket(c.cartId, guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    const sent = await ws.call<{ ok: boolean }>('transfer');
    expect(sent.result).toMatchObject({ ok: true });
    expect((await api().cartSnapshot(c.cartId))?.cart?.status).toBe('returned');
  });

  it('is the only one who sends it back, and is slowed down when editing in a burst', async () => {
    const c = await open({ lines: [{ sku: 'WID-100', qty: 1 }] });
    const ada = { kind: 'staff' as const, id: 'usr_ada', name: 'Ada', role: 'admin' as const };
    expect(await cartAgent(c.cartId).transferAs(ada)).toEqual({
      ok: false,
      error: 'Only the buyer sends the cart back.',
    });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const ws = await guestSocket(c.cartId, guest);
    if (!ws.call) throw new Error('socket refused');
    const results = [];
    for (let i = 0; i < 21; i++)
      results.push((await ws.call('apply', [{ op: 'add', sku: 'WID-100', qty: 1 }])).result);
    expect(results.slice(0, 20).every((r) => (r as { ok: boolean }).ok)).toBe(true);
    expect(results[20]).toEqual({ ok: false, error: 'Slow down a moment.' });
  });

  it('is never admitted to a staff cart', async () => {
    const staff = await api().createCart({
      title: 'Staff cart',
      flowId: 'tpl-b2b-order',
      createdBy: 'usr_1',
    });
    if (!staff.ok) throw new Error(staff.error);
    const forged = { cartId: staff.id, id: 'guest:x', name: 'X' };
    expect((await guestSocket(staff.id, forged)).status).toBe(403);
    expect(await cartAgent(staff.id).redeemStart('anything')).toBeNull();
  });

  it('can’t use a start link once the cart’s time has passed', async () => {
    // A second's margin: opening refuses a time already past, and under load it can take a while.
    const c = await open({ expiresAt: Date.now() + 1_000 });
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await cartAgent(c.cartId).redeemStart(c.token)).toBeNull();
    expect(await cartAgent(c.cartId).issueStart()).toBeNull();
  });

  it('loses the cart when it expires', async () => {
    const c = await open();
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    await atTime(c.cartId, Date.now());
    await cartAgent(c.cartId).expire();
    expect((await api().cartSnapshot(c.cartId))?.cart?.status).toBe('canceled');
    expect((await guestSocket(c.cartId, guest)).status).toBe(410);
    expect(await cartAgent(c.cartId).issueStart()).toBeNull();
  });
});

/** Sets the cart's time, as though it opened with it or that much time had passed. */
const atTime = (cartId: string, expiresAt: number) =>
  runInDurableObject(cartAgent(cartId), async (a) => {
    const c = a.state.cart!;
    a.setState({ ...a.state, cart: { ...c, external: { ...c.external!, expiresAt } } });
  });

/** The cart's time, as its agent, the D1 row the gate reads and its expiry schedule have it. */
async function timeOf(cartId: string) {
  const cart = (await api().cartSnapshot(cartId))!.cart!;
  const row = await db().select().from(carts).where(eq(carts.id, cartId)).get();
  const schedules = await runInDurableObject(cartAgent(cartId), (a) => a.listSchedules());
  return {
    cart,
    expiresAt: cart.external!.expiresAt,
    indexed: row!.expiresAt,
    alarms: schedules.filter((s) => s.callback === 'expire').map((s) => s.time),
  };
}

/** Runs `fn` with the example plugin's `carts:external` grant withdrawn, here and in the agent. */
async function withoutGrant(cartId: string, fn: () => Promise<void>) {
  type Grants = { PLUGIN_GRANTS?: string };
  const grants = (env as Grants).PLUGIN_GRANTS;
  const set = async (v: string | undefined) => {
    (env as Grants).PLUGIN_GRANTS = v;
    await runInDurableObject(cartAgent(cartId), async (a) => {
      (a as unknown as { env: Grants }).env.PLUGIN_GRANTS = v;
    });
  };
  await set(JSON.stringify({ example: { capabilities: ['orders:start'] } }));
  try {
    await fn();
  } finally {
    await set(grants);
  }
}

/** The cart's socket as a signed-in admin, as the web proxy opens it. */
async function staffSocket(cartId: string) {
  const id = 'usr_keepopen_ada';
  await db()
    .insert(users)
    .values({
      id,
      email: 'keepopen-ada@example.com',
      name: 'Ada',
      role: 'admin',
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  await db()
    .insert(sessions)
    .values({
      tokenHash: `sess_${id}`,
      userId: id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })
    .onConflictDoNothing();
  const path = `/agents/cart-agent/${cartId}`;
  const headers = new Headers({ Upgrade: 'websocket' });
  headers.set(
    PRINCIPAL_HEADER,
    await signPrincipal(
      (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!,
      {
        kind: 'user',
        id,
        name: 'Ada',
        email: 'keepopen-ada@example.com',
        role: 'admin',
        session: `sess_${id}`,
      },
      path,
    ),
  );
  const res = await worker.fetch(new Request(`http://engine${path}`, { headers }), env);
  const ws = res.webSocket;
  if (!ws) throw new Error(`socket refused: ${res.status}`);
  ws.accept();
  const pending = new Map<string, (m: { result?: unknown }) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
  });
  let n = 0;
  return {
    call: (method: string, args: unknown[] = []) =>
      new Promise<{ result?: unknown }>((resolve) => {
        const rid = `s${++n}`;
        pending.set(rid, resolve);
        ws.send(JSON.stringify({ type: 'rpc', id: rid, method, args }));
      }),
  };
}

describe('an external cart that stays open while its buyer works', () => {
  const H = 3_600_000;

  it('moves its time on when its buyer connects or edits, at most once a minute', async () => {
    const c = await open({ expiresAt: Date.now() + 10 * 60_000, idleMs: 2 * H });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const before = Date.now();
    const ws = await guestSocket(c.cartId, guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    const moved = await timeOf(c.cartId);
    expect(moved.expiresAt).toBeGreaterThanOrEqual(before + 2 * H);
    expect(moved.expiresAt).toBeLessThanOrEqual(Date.now() + 2 * H);
    // The gate and the alarm go by the same time, and the old alarm is gone.
    expect(moved.indexed).toBe(moved.expiresAt);
    expect(moved.alarms).toEqual([Math.floor(moved.expiresAt / 1000)]);
    // An edit straight after moves nothing, and isn't a change to the cart's time.
    const version = moved.cart.version;
    expect((await ws.call('apply', [{ op: 'add', sku: 'WID-100', qty: 1 }])).result).toEqual({
      ok: true,
    });
    const again = await timeOf(c.cartId);
    expect(again.expiresAt).toBe(moved.expiresAt);
    expect(again.cart.version).toBe(version + 1);

    // Once the window has run down a minute or more, the next edit moves it again.
    await atTime(c.cartId, Date.now() + 30 * 60_000);
    const t = Date.now();
    expect((await ws.call('say', ['Still here'])).result).toMatchObject({ ok: true });
    const later = await timeOf(c.cartId);
    expect(later.expiresAt).toBeGreaterThanOrEqual(t + 2 * H);
    expect(later.alarms).toEqual([Math.floor(later.expiresAt / 1000)]);
  });

  it('never stays open past 24 hours from when it opened, and lets its buyer in for that long', async () => {
    const c = await open({ expiresAt: Date.now() + H, idleMs: MAX_EXTERNAL_CART_MS });
    const redeemed = (await api().redeemCartStart(c.cartId, c.token))!;
    const { cart } = await timeOf(c.cartId);
    const cap = cart.createdAt + MAX_EXTERNAL_CART_MS;
    // The buyer's cookie covers every extension, and no more.
    expect(redeemed.expiresAt).toBe(cap);
    const ws = await guestSocket(c.cartId, redeemed.guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    expect((await timeOf(c.cartId)).expiresAt).toBe(cap);
    expect((await ws.call('whoami')).result).toMatchObject({ kind: 'guest' });
    expect((await timeOf(c.cartId)).expiresAt).toBe(cap);
  });

  it('keeps the time a cart opened with when it has no idle window', async () => {
    const expiresAt = Date.now() + 10 * 60_000;
    const c = await open({ expiresAt });
    const redeemed = (await api().redeemCartStart(c.cartId, c.token))!;
    expect(redeemed.expiresAt).toBe(expiresAt);
    const ws = await guestSocket(c.cartId, redeemed.guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    await ws.call('apply', [{ op: 'add', sku: 'WID-100', qty: 1 }]);
    const t = await timeOf(c.cartId);
    expect(t.expiresAt).toBe(expiresAt);
    expect(t.indexed).toBe(expiresAt);
    expect(t.alarms).toEqual([Math.floor(expiresAt / 1000)]);
    // Nor does a cart stored before idle windows, which has none at all.
    const old = await open({ expiresAt, idleMs: 2 * H });
    await runInDurableObject(cartAgent(old.cartId), async (a) => {
      const { idleMs: _, ...external } = a.state.cart!.external!;
      a.setState({ ...a.state, cart: { ...a.state.cart!, external: external as never } });
    });
    const guest = (await cartAgent(old.cartId).redeemStart(old.token))!;
    const ows = await guestSocket(old.cartId, guest);
    if (!ows.call) throw new Error(`socket refused: ${ows.status}`);
    await ows.call('whoami');
    expect((await timeOf(old.cartId)).expiresAt).toBe(expiresAt);
  });

  it('is moved on only by its own buyer, and not once the plugin may no longer have carts', async () => {
    const expiresAt = Date.now() + 10 * 60_000;
    const mine = await open({ expiresAt, idleMs: 2 * H });
    const theirs = await open({ expiresAt, idleMs: 2 * H });
    const guest = (await cartAgent(mine.cartId).redeemStart(mine.token))!;
    // Signed for one cart, refused at the other's gate, which keeps its time.
    expect(
      (await guestSocket(theirs.cartId, guest, `/agents/cart-agent/${theirs.cartId}`)).status,
    ).toBe(401);
    expect((await timeOf(theirs.cartId)).expiresAt).toBe(expiresAt);

    // Without the grant the gate refuses the buyer, and nothing reaching the cart moves it either.
    await withoutGrant(mine.cartId, async () => {
      expect((await guestSocket(mine.cartId, guest)).status).toBe(410);
      await api().keepCartOpen(
        mine.cartId,
        await signedActor({ kind: 'guest', id: guest.id, name: guest.name }, `cart:${mine.cartId}`),
      );
      expect((await timeOf(mine.cartId)).expiresAt).toBe(expiresAt);
    });
  });

  it('is not moved on by staff, whose activity isn’t the buyer’s', async () => {
    const expiresAt = Date.now() + 10 * 60_000;
    const c = await open({ expiresAt, idleMs: 2 * H });
    const ada = await staffSocket(c.cartId);
    expect((await ada.call('whoami')).result).toMatchObject({ kind: 'staff' });
    expect((await timeOf(c.cartId)).expiresAt).toBe(expiresAt);
  });

  it('is moved on by its buyer’s searches, files and downloads too', async () => {
    const c = await open({ expiresAt: Date.now() + 10 * 60_000, idleMs: 2 * H });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const buyer = { kind: 'guest' as const, id: guest.id, name: guest.name };
    const signed = () => signedActor(buyer, `cart:${c.cartId}`);
    const moved = async (act: () => Promise<unknown>) => {
      await atTime(c.cartId, Date.now() + 10 * 60_000);
      const t = Date.now();
      await act();
      return (await timeOf(c.cartId)).expiresAt >= t + 2 * H;
    };
    expect(
      await moved(async () =>
        expect(await api().searchCartProducts(c.cartId, 'widget', await signed())).toMatchObject({
          ok: true,
        }),
      ),
    ).toBe(true);
    const id = 'att_keepopen1';
    expect(
      await moved(async () =>
        expect(
          await api().attachToCart(
            c.cartId,
            {
              id,
              name: 'po.pdf',
              type: 'application/pdf',
              size: 10,
              key: `carts/${c.cartId}/${id}`,
            },
            await signed(),
          ),
        ).toEqual({ ok: true }),
      ),
    ).toBe(true);
    expect(await moved(async () => api().keepCartOpen(c.cartId, await signed()))).toBe(true);
    // Staff signed for the same call move nothing; nor does a cart no one opened.
    const ada = { kind: 'staff' as const, id: 'usr_ada', name: 'Ada', role: 'admin' as const };
    expect(
      await moved(async () =>
        api().keepCartOpen(c.cartId, await signedActor(ada, `cart:${c.cartId}`)),
      ),
    ).toBe(false);
    await api().keepCartOpen('cart_nobody', await signedActor(buyer, 'cart:cart_nobody'));
  });

  it('keeps the index row a cancel wrote while it was moved on', async () => {
    const c = await open({ expiresAt: Date.now() + 10 * 60_000, idleMs: 2 * H });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const ws = await guestSocket(c.cartId, guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    // As though a cancel's index landed between the agent moving the time and writing it.
    await atTime(c.cartId, Date.now() + 10 * 60_000);
    await db().update(carts).set({ status: 'canceled' }).where(eq(carts.id, c.cartId));
    const before = (await db().select().from(carts).where(eq(carts.id, c.cartId)).get())!;
    await ws.call('whoami');
    const row = (await db().select().from(carts).where(eq(carts.id, c.cartId)).get())!;
    expect(row.status).toBe('canceled');
    expect(row.expiresAt).toBe(before.expiresAt);
  });

  it('lets a returned cart’s buyer back only until its time, and while the plugin may have carts', async () => {
    const c = await open({
      expiresAt: Date.now() + 10 * 60_000,
      idleMs: 2 * H,
      lines: [{ sku: 'WID-100', qty: 1 }],
    });
    const redeemed = (await api().redeemCartStart(c.cartId, c.token))!;
    const ws = await guestSocket(c.cartId, redeemed.guest);
    if (!ws.call) throw new Error(`socket refused: ${ws.status}`);
    expect((await ws.call<{ ok: boolean }>('transfer')).result).toMatchObject({ ok: true });
    const { expiresAt, cart } = await timeOf(c.cartId);
    expect(cart.status).toBe('returned');
    // Returned, it can be opened again to post it again, and activity no longer moves it.
    const again = await guestSocket(c.cartId, redeemed.guest);
    if (!again.call) throw new Error(`socket refused: ${again.status}`);
    await atTime(c.cartId, expiresAt - 30 * 60_000);
    await again.call('returnForm');
    expect((await timeOf(c.cartId)).expiresAt).toBe(expiresAt - 30 * 60_000);
    await withoutGrant(c.cartId, async () => {
      expect((await guestSocket(c.cartId, redeemed.guest)).status).toBe(410);
    });
    // Past its time, though well before its cap and the buyer's cookie, it is closed to them.
    await atTime(c.cartId, Date.now() - 1);
    await db()
      .update(carts)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(carts.id, c.cartId));
    expect(redeemed.expiresAt).toBeGreaterThan(Date.now() + H);
    expect((await guestSocket(c.cartId, redeemed.guest)).status).toBe(410);
    expect((await again.call('returnForm')).error).toMatch(/closed/);
  });

  it('closes at its time even after an expiry alarm from before it was moved on', async () => {
    const c = await open({ expiresAt: Date.now() + 10 * 60_000, idleMs: 2 * H });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    await guestSocket(c.cartId, guest);
    const { expiresAt } = await timeOf(c.cartId);
    // An alarm that fires before the cart's time reschedules for it, and cancels nothing.
    await cartAgent(c.cartId).expire();
    const t = await timeOf(c.cartId);
    expect(t.cart.status).toBe('open');
    expect(t.alarms).toEqual([Math.floor(expiresAt / 1000)]);
    await atTime(c.cartId, Date.now());
    await cartAgent(c.cartId).expire();
    expect((await timeOf(c.cartId)).cart.status).toBe('canceled');
    // Activity on a closed cart doesn't bring it back.
    expect((await guestSocket(c.cartId, guest)).status).toBe(410);
  });
});

describe('a punchout buyer’s data subject request', () => {
  it('exports their carts with what they said and sent, and erases it', async () => {
    const email = `buyer-${crypto.randomUUID().slice(0, 6)}@northwind.example`;
    const c = await open({ buyer: { id: email.toUpperCase(), name: 'Bea Buyer' } });
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    const ws = await guestSocket(c.cartId, guest);
    if (!ws.call) throw new Error('socket refused');
    await ws.call('say', ['Please ship to my home, Bea Buyer']);
    const home = {
      name: 'Bea Buyer',
      line1: '4 Elm Row',
      city: 'Leeds',
      postalCode: 'LS2 7EY',
      country: 'GB',
    };
    // The buyer sets it on their own page: the socket's op, bounded by the cart itself.
    expect((await ws.call('apply', [{ op: 'set_ship_to', address: home }])).result).toEqual({
      ok: true,
    });
    await env.DOCS.put(`carts/${c.cartId}/att_b1`, '%PDF');
    await api().attachToCart(
      c.cartId,
      {
        id: 'att_b1',
        name: 'my-po.pdf',
        type: 'application/pdf',
        size: 4,
        key: `carts/${c.cartId}/att_b1`,
      },
      await signedActor({ kind: 'guest', id: guest.id, name: guest.name }, `cart:${c.cartId}`),
    );
    const staffer = { kind: 'staff' as const, id: 'usr_ops', name: 'Ops', role: 'admin' as const };
    await cartAgent(c.cartId).applyAs(staffer, { op: 'add', sku: 'WID-100', qty: 1 });

    const exported = await exportDataSubject(env, email);
    expect(exported.carts).toEqual([
      expect.objectContaining({
        id: c.cartId,
        buyer: { id: email.toUpperCase(), name: 'Bea Buyer' },
        shipTo: home,
        messages: [expect.objectContaining({ body: 'Please ship to my home, Bea Buyer' })],
        files: [expect.objectContaining({ name: 'my-po.pdf' })],
      }),
    ]);

    const erased = await eraseDataSubject(env, email);
    expect(erased).toMatchObject({ ok: true, carts: 1 });
    const s = (await api().cartSnapshot(c.cartId))!;
    expect(s.cart).toMatchObject({
      status: 'canceled',
      shipTo: null,
      external: { buyer: { id: '[erased]', name: '[erased]' } },
    });
    expect(s.chat.map((m) => m.body)).not.toContain('Please ship to my home, Bea Buyer');
    expect(s.attachments).toEqual([]);
    expect(await env.DOCS.get(`carts/${c.cartId}/att_b1`)).toBeNull();
    const row = await db().select().from(carts).where(eq(carts.id, c.cartId)).get();
    // Indexed, with no buyer: neither found by a request nor backfilled again.
    expect(row?.buyerId).toBe('');
    expect((await exportDataSubject(env, email)).carts).toEqual([]);
  });
});

describe('external carts from before buyers were indexed', () => {
  it('are given their buyer by the sweep, once, so a data subject request finds them', async () => {
    const email = `old-${crypto.randomUUID().slice(0, 6)}@northwind.example`;
    const c = await open({ buyer: { id: email, name: 'Olga Old' } });
    // As a row written before migration 0050 looks.
    await db().update(carts).set({ buyerId: null }).where(eq(carts.id, c.cartId));
    expect((await exportDataSubject(env, email)).carts).toEqual([]);
    expect(await indexCartBuyers(env)).toBeGreaterThanOrEqual(1);
    expect((await db().select().from(carts).where(eq(carts.id, c.cartId)).get())?.buyerId).toBe(
      email,
    );
    expect((await exportDataSubject(env, email)).carts).toEqual([
      expect.objectContaining({ id: c.cartId }),
    ]);
    // A second sweep finds nothing left to do for it.
    await indexCartBuyers(env);
    const again = await db().select().from(carts).where(eq(carts.id, c.cartId)).get();
    expect(again?.buyerId).toBe(email);
  });

  it('erases a buyer from such a cart if they were erased before it named them', async () => {
    const email = `gone-${crypto.randomUUID().slice(0, 6)}@northwind.example`;
    const c = await open({ buyer: { id: email, name: 'Gina Gone' } });
    await db().update(carts).set({ buyerId: null }).where(eq(carts.id, c.cartId));
    // Their erasure ran while the cart had no buyer on its row, so it couldn't find it.
    await db()
      .insert(auditEvents)
      .values({
        id: `aud_${crypto.randomUUID()}`,
        at: Date.now(),
        action: 'personal_data.erased',
        target: await subjectTarget(email),
      });
    await indexCartBuyers(env);
    const s = (await api().cartSnapshot(c.cartId))!;
    expect(s.cart?.external?.buyer).toEqual({ id: '[erased]', name: '[erased]' });
    expect((await db().select().from(carts).where(eq(carts.id, c.cartId)).get())?.buyerId).toBe('');
    expect((await exportDataSubject(env, email)).carts).toEqual([]);
  });

  it('marks a row with nothing behind it as done, and an erasure of no one finds no cart', async () => {
    const id = `cart_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await db()
      .insert(carts)
      .values({
        id,
        title: 'Bare',
        status: 'open',
        flowId: 'tpl-b2b-order',
        pluginId: 'example',
        sessionRef: `bare-${id}`,
        createdBy: 'plugin:example',
        createdAt: now,
        updatedAt: now,
      });
    await indexCartBuyers(env);
    expect((await db().select().from(carts).where(eq(carts.id, id)).get())?.buyerId).toBe('');
    expect((await exportDataSubject(env, '')).carts).toEqual([]);
  });
});
