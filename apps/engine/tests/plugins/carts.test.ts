import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type CartGuest,
  type CartState,
  type ExternalCartInput,
  PRINCIPAL_HEADER,
  signCartGuest,
} from '@orderloop/core';
import { carts, createDb, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import worker from '../../src/index';
import { PluginHost } from '../../src/plugin-api';

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
    expect(order!.idempotencyKey).toBe(`plugin:example:${req.key}`);
    expect(
      (await hostFor('example').startOrder({ ...req, key: '' })) as { ok: boolean },
    ).toMatchObject({ ok: false });
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

  it('loses the cart when it expires', async () => {
    const c = await open();
    const guest = (await cartAgent(c.cartId).redeemStart(c.token))!;
    await cartAgent(c.cartId).expire();
    expect((await api().cartSnapshot(c.cartId))?.cart?.status).toBe('canceled');
    expect((await guestSocket(c.cartId, guest)).status).toBe(410);
    expect(await cartAgent(c.cartId).issueStart()).toBeNull();
  });
});
