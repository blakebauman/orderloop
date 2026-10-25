import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type CartGuest,
  type CartState,
  type ExternalCartInput,
  PRINCIPAL_HEADER,
  signCartGuest,
  subjectTarget,
} from '@orderloop/core';
import { auditEvents, carts, createDb, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import worker from '../../src/index';
import { PluginHost } from '../../src/plugin-api';
import { indexCartBuyers } from '../../src/retention';
import { eraseDataSubject, exportDataSubject } from '../../src/subjects';

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
    await cartAgent(c.cartId).expire();
    expect((await api().cartSnapshot(c.cartId))?.cart?.status).toBe('canceled');
    expect((await guestSocket(c.cartId, guest)).status).toBe(410);
    expect(await cartAgent(c.cartId).issueStart()).toBeNull();
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
      { kind: 'guest', id: guest.id, name: guest.name },
    );
    const staffer = { kind: 'staff' as const, id: 'usr_ops', name: 'Ops', role: 'admin' as const };
    await cartAgent(c.cartId).applyAs(staffer, { op: 'add', sku: 'WID-100', qty: 1 });

    const exported = await exportDataSubject(env, email);
    expect(exported.carts).toEqual([
      expect.objectContaining({
        id: c.cartId,
        buyer: { id: email.toUpperCase(), name: 'Bea Buyer' },
        messages: [expect.objectContaining({ body: 'Please ship to my home, Bea Buyer' })],
        files: [expect.objectContaining({ name: 'my-po.pdf' })],
      }),
    ]);

    const erased = await eraseDataSubject(env, email);
    expect(erased).toMatchObject({ ok: true, carts: 1 });
    const s = (await api().cartSnapshot(c.cartId))!;
    expect(s.cart).toMatchObject({
      status: 'canceled',
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
