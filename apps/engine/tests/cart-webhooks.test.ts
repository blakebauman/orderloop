/**
 * A cart's outbound events: each sent once, on the change it announces, signed with the
 * subscription's secret, carrying the cart without who its buyer is; a retry resends only what
 * didn't arrive. Carts that go back to a buyer's system (`cart.returned`) need the plugin that
 * opened them: tests/plugins/carts.test.ts.
 */

import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  CART_EVENT_RETRIES,
  type CartActor,
  type CartEventPayload,
  type CartSummary,
  cartSummary,
  TERMINAL_ORDER_STATUSES,
  verifyWebhook,
} from '@orderloop/core';
import {
  carts,
  createDb,
  customers,
  users,
  webhookDeliveries,
  webhookSubscriptions,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineApi } from '../src/api';
import { createCart } from '../src/cart/carts';
import { ensureTemplates } from '../src/flows';
import { eraseDataSubject } from '../src/subjects';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const cart = (id: string) => env.CART_AGENT.getByName(id);
type Queued = { id: string; callback: string; time: number; payload: { attempt: number } };
/** The cart's queued event deliveries (the stub's RPC typing doesn't carry `getSchedules`). */
const queued = async (id: string) =>
  ((await (cart(id).getSchedules() as unknown)) as Queued[]).filter(
    (q) => q.callback === 'emitWebhook',
  );
const unqueue = async (id: string) => {
  for (const q of await queued(id)) await cart(id).cancelSchedule(q.id);
};
const ada: CartActor = { kind: 'staff', id: 'usr_hooks_ada', name: 'Ada', role: 'operator' };

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

beforeAll(async () => {
  await ensureTemplates(env);
  await db()
    .insert(users)
    .values({ id: ada.id, email: 'ada@hooks.example', name: 'Ada', role: 'operator', createdAt: 0 })
    .onConflictDoNothing();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await introspector?.dispose();
  introspector = undefined;
  await db().delete(webhookSubscriptions);
});

const subscribe = (id: string, events: string[]) =>
  db()
    .insert(webhookSubscriptions)
    .values({
      id,
      url: `https://hooks.example/${id}`,
      secret: `whsec_${id}`,
      events: JSON.stringify(events),
      createdAt: Date.now(),
    });

type Received = { url: string; body: string; headers: Headers; payload: CartEventPayload };

/** What subscribers are sent; `answer` says how the receiver responds to each. */
function receiver(answer: (url: string) => Response = () => new Response('ok')) {
  const received: Received[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = String(init?.body);
    received.push({
      url: String(url),
      body,
      headers: new Headers(init?.headers),
      payload: JSON.parse(body),
    });
    return answer(String(url));
  });
  return received;
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const rows = (cartId: string) =>
  db().select().from(webhookDeliveries).where(eq(webhookDeliveries.orderId, cartId));

/** Waits for the cart's deliveries to be `n`, every one of them settled. */
const settled = (cartId: string, n: number) =>
  until(async () => {
    const r = await rows(cartId);
    return r.length === n && r.every((x) => x.status !== 'pending') && r;
  }, `${n} settled deliveries for ${cartId}`);

async function staffCart() {
  const made = await api().createCart({
    title: 'Q4 restock',
    flowId: 'tpl-b2b-order',
    customerId: 'cus_northwind',
    createdBy: ada.id,
  });
  if (!made.ok) throw new Error(made.error);
  return made.id;
}

async function externalCart(title = 'Punchout') {
  const made = await createCart(
    env,
    { title, flowId: 'tpl-b2b-order', customerId: 'cus_northwind', createdBy: 'plugin:example' },
    {
      pluginId: 'example',
      sessionRef: `s-${crypto.randomUUID()}`,
      expiresAt: Date.now() + 3_600_000,
      returnUrl: 'https://buyer.example/return',
      frameOrigins: [],
      buyer: { id: 'bee@buyer.example', name: 'Bee Buyer' },
    },
    [{ sku: 'WID-100', qty: 3 }],
  );
  if (!made.ok) throw new Error(made.error);
  return made.id;
}

describe('cart events', () => {
  it('announces a staff cart once when it opens and once when it is submitted, signed', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const received = receiver();
    await subscribe('carts', ['cart.created', 'cart.submitted', 'cart.canceled']);
    await subscribe('submits', ['cart.submitted']);
    const id = await staffCart();
    await settled(id, 1);

    // Editing a cart announces nothing.
    await cart(id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 10 });
    const dock = {
      name: 'Dock 4',
      line1: '1 Hauptstr.',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    };
    await cart(id).applyAs(ada, { op: 'set_ship_to', address: dock });
    await cart(id).applyAs(ada, { op: 'lock' });
    await cart(id).applyAs(ada, { op: 'unlock' });
    const done = await cart(id).submitAs(ada);
    if (!done.ok) throw new Error(done.error);
    // A replayed submit is refused and announces nothing more.
    expect((await cart(id).submitAs(ada)).ok).toBe(false);
    expect((await cart(id).cancelAs(ada)).ok).toBe(false);
    await settled(id, 3);

    const mine = received.filter((r) => r.payload.cartId === id);
    const to = (sub: string) =>
      mine.filter((r) => r.url.endsWith(`/${sub}`)).map((r) => r.payload.event);
    expect(to('carts')).toEqual(['cart.created', 'cart.submitted']);
    expect(to('submits')).toEqual(['cart.submitted']);
    for (const r of mine) {
      const sub = r.url.split('/').pop()!;
      expect(
        await verifyWebhook(`whsec_${sub}`, r.body, r.headers.get('x-orderloop-signature')),
      ).toMatchObject({ ok: true });
      expect(r.headers.get('x-orderloop-event')).toBe(r.payload.event);
      expect(r.headers.get('x-orderloop-delivery')).toBe(r.payload.id);
    }

    const created = mine.find((r) => r.payload.event === 'cart.created')!.payload;
    expect(created).toMatchObject({ cartId: id, orderId: null });
    expect(created.data.cart).toMatchObject({ id, status: 'open', source: 'staff', lines: [] });
    const submitted = mine.find((r) => r.payload.event === 'cart.submitted')!.payload;
    expect(submitted).toMatchObject({ cartId: id, orderId: done.orderId });
    expect(submitted.data.cart).toMatchObject({
      status: 'submitted',
      orderId: done.orderId,
      customerId: 'cus_northwind',
      pluginId: null,
      lines: [{ sku: 'WID-100', qty: 10 }],
      quote: { currency: 'USD', total: expect.any(Number) },
    });
    // Where it ships stays on the cart and its order.
    for (const where of ['Dock 4', 'Hauptstr'])
      expect(JSON.stringify(submitted)).not.toContain(where);
    expect((await rows(id)).every((r) => r.status === 'delivered' && r.attempts === 1)).toBe(true);
  });

  it('announces a cancel once', async () => {
    const received = receiver();
    await subscribe('cancels', ['cart.canceled']);
    const id = await staffCart();
    expect(await cart(id).cancelAs(ada)).toEqual({ ok: true });
    expect((await cart(id).cancelAs(ada)).ok).toBe(false);
    const [row] = await settled(id, 1);
    expect(row).toMatchObject({ event: 'cart.canceled', status: 'delivered' });
    expect(received.filter((r) => r.payload.cartId === id).map((r) => r.payload.event)).toEqual([
      'cart.canceled',
    ]);
  });

  it('announces an external cart that expires as expired, without its buyer', async () => {
    const received = receiver();
    await subscribe('ends', ['cart.expired', 'cart.canceled']);
    const id = await externalCart();
    await cart(id).expire();
    // Expiring twice ends nothing more.
    await cart(id).expire();
    const [row] = await settled(id, 1);
    expect(row!.event).toBe('cart.expired');
    const [sent] = received.filter((r) => r.payload.cartId === id);
    expect(sent!.payload.data.cart).toMatchObject({
      status: 'canceled',
      source: 'external',
      pluginId: 'example',
      lines: [{ sku: 'WID-100', qty: 3 }],
    });
    for (const personal of ['bee@buyer.example', 'Bee Buyer', 'buyer.example/return', 'sessionRef'])
      expect(sent!.body).not.toContain(personal);
  });

  it('drops an erased buyer’s cart events and announces the cancel without their name', async () => {
    receiver(() => new Response('down', { status: 503 }));
    await subscribe('all', ['*']);
    const id = await externalCart('Punchout for Bee Buyer');
    const [created] = await settled(id, 1);
    expect(created).toMatchObject({ event: 'cart.created', status: 'failed' });
    expect(created!.payload).toContain('Bee Buyer');

    vi.restoreAllMocks();
    const received = receiver();
    await cart(id).eraseSubject(['bee@buyer.example']);
    const [canceled] = await settled(id, 1);
    expect(canceled).toMatchObject({ event: 'cart.canceled', status: 'delivered' });
    expect(canceled!.payload).not.toContain('Bee Buyer');
    expect(received.map((r) => r.payload.event)).toEqual(['cart.canceled']);
    // The failed cart.created isn't retried with the name it carried.
    expect(await queued(id)).toEqual([]);
  });

  it('resends only a delivery that failed, under the same id, and nothing once it arrived', async () => {
    let up = false;
    const received = receiver((url) =>
      up || url.endsWith('/steady') ? new Response('ok') : new Response('down', { status: 503 }),
    );
    await subscribe('flaky', ['cart.canceled']);
    await subscribe('steady', ['cart.canceled']);
    const id = await staffCart();
    // The first attempt runs from the cart's schedule; the receiver that's down fails.
    await cart(id).cancelAs(ada);
    await settled(id, 2);
    const summary = cartSummary((await api().cartSnapshot(id))!.cart!);
    const retry = () => cart(id).emitWebhook({ event: 'cart.canceled', cart: summary, attempt: 5 });

    up = true;
    const before = received.length;
    await retry();
    await retry();
    const resent = received.slice(before);
    // Each subscription's first attempt went to both; the retry only to the one that was down.
    expect(resent.map((r) => r.url)).toEqual(['https://hooks.example/flaky']);
    const first = received.find((r) => r.url.endsWith('/flaky'))!;
    expect(resent[0]!.payload.id).toBe(first.payload.id);
    expect(resent[0]!.headers.get('x-orderloop-delivery')).toBe(first.payload.id);

    const after = await rows(id);
    expect(after).toHaveLength(2);
    expect(after.map((r) => [r.subscriptionId, r.status, r.attempts]).sort()).toEqual([
      ['flaky', 'delivered', 2],
      ['steady', 'delivered', 1],
    ]);
  });

  it('keeps retrying past six failures, for about a day, and then leaves the delivery failed', async () => {
    let down = true;
    receiver(() => (down ? new Response('no', { status: 500 }) : new Response('ok')));
    await subscribe('slow', ['cart.canceled']);
    const id = await staffCart();
    await cart(id).cancelAs(ada);
    await until(async () => (await rows(id))[0]?.attempts === 1, 'the first attempt');
    const summary = cartSummary((await api().cartSnapshot(id))!.cart!);
    const attempt = async (n: number) => {
      await unqueue(id);
      await cart(id).emitWebhook({ event: 'cart.canceled', cart: summary, attempt: n, erasure: 0 });
    };
    for (let n = 1; n <= 5; n++) await attempt(n);
    // Six failures in, the next try is still queued, ten seconds doubled six times later.
    const [next] = await queued(id);
    expect(next!.payload.attempt).toBe(6);
    const wait = next!.time * 1000 - Date.now();
    expect(wait).toBeGreaterThan(300_000);
    expect(wait).toBeLessThanOrEqual(320_000);
    expect((await rows(id))[0]).toMatchObject({
      status: 'failed',
      attempts: 6,
      responseStatus: 500,
    });

    down = false;
    await attempt(6);
    expect((await rows(id))[0]).toMatchObject({ status: 'delivered', attempts: 7 });
    expect(await queued(id)).toEqual([]);
  });

  it('gives up after its last retry, the delivery left failed where its subscription shows it', async () => {
    receiver(() => new Response('no', { status: 500 }));
    await subscribe('dead', ['cart.canceled']);
    const id = await staffCart();
    await cart(id).cancelAs(ada);
    await until(async () => (await rows(id))[0]?.attempts === 1, 'the first attempt');
    await unqueue(id);
    const summary = cartSummary((await api().cartSnapshot(id))!.cart!);
    await cart(id).emitWebhook({
      event: 'cart.canceled',
      cart: summary,
      attempt: CART_EVENT_RETRIES,
      erasure: 0,
    });
    expect(await queued(id)).toEqual([]);
    expect((await rows(id))[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('takes back what a delivery on its way wrote when an erasure ran meanwhile', async () => {
    let calls = 0;
    const received = receiver();
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as CartEventPayload;
      received.push({ url: '', body: String(init?.body), headers: new Headers(), payload });
      // The first, cart.created, is slow and then fails: the erasure runs while it is on its way.
      // (Its timer runs in the cart's own context; a promise the test settled would never reach it.)
      if (++calls === 1)
        return new Promise<Response>((r) =>
          setTimeout(() => r(new Response('down', { status: 503 })), 2_000),
        );
      return new Response('ok');
    });
    await subscribe('all', ['*']);
    const id = await externalCart('Punchout for Bee Buyer');
    await until(async () => calls === 1, 'cart.created on its way');
    await cart(id).eraseSubject(['bee@buyer.example']);
    // Erased before the slow delivery answered.
    expect(calls).toBe(1);
    await until(
      async () =>
        (await rows(id)).some((r) => r.event === 'cart.canceled' && r.status === 'delivered'),
      'cart.canceled delivered',
    );
    await until(async () => (await rows(id)).length === 1, 'the stale delivery taken back');
    expect((await rows(id)).map((r) => r.event)).toEqual(['cart.canceled']);
    // Nothing queued to send the old title again, and a stale retry sends nothing.
    expect(await queued(id)).toEqual([]);
    const stale = received.find((r) => r.payload.event === 'cart.created')!.payload.data
      .cart as CartSummary;
    await cart(id).emitWebhook({ event: 'cart.created', cart: stale, attempt: 1, erasure: 0 });
    expect(received).toHaveLength(2);
    expect((await rows(id)).every((r) => !r.payload.includes('Bee Buyer'))).toBe(true);
  });

  it('forgets a staff cart’s events and erases its title when its customer is erased', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const received = receiver();
    await subscribe('all', ['*']);
    const customerId = `cus_quill_${crypto.randomUUID().slice(0, 6)}`;
    const email = `${customerId}@example.com`;
    await db().insert(customers).values({ id: customerId, name: 'Quill Hardware', email });
    const made = await api().createCart({
      title: 'Restock for Quill Hardware',
      flowId: 'tpl-b2b-order',
      customerId,
      createdBy: ada.id,
    });
    if (!made.ok) throw new Error(made.error);
    const id = made.id;
    await cart(id).applyAs(ada, { op: 'add', sku: 'WID-100', qty: 1 });
    const done = await cart(id).submitAs(ada);
    if (!done.ok) throw new Error(done.error);
    await settled(id, 2);
    // The order ends (cancelled where it waits), so the customer can be erased.
    const order = env.ORDER_AGENT.getByName(done.orderId);
    const status = async () => ((await order.snapshot()) as { status: string }).status;
    await until(async () => !['queued', 'running'].includes(await status()), 'the order to wait');
    if (!TERMINAL_ORDER_STATUSES.includes((await status()) as never)) await order.cancel('test');
    await until(
      async () => TERMINAL_ORDER_STATUSES.includes((await status()) as never),
      'the order to end',
    );
    expect(received.some((r) => r.body.includes('Quill Hardware'))).toBe(true);

    expect(await eraseDataSubject(env, email)).toMatchObject({ ok: true });
    expect(await rows(id)).toEqual([]);
    const all = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, 'all'));
    expect(all.filter((r) => r.payload.includes('Quill Hardware'))).toEqual([]);
    const after = (await api().cartSnapshot(id))!.cart!;
    expect(after.title).not.toContain('Quill Hardware');
    const row = await db().select().from(carts).where(eq(carts.id, id)).get();
    expect(row!.title).toBe(after.title);
    expect(await queued(id)).toEqual([]);
  });
});
