import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type OrderInput, type OrderState, TERMINAL_ORDER_STATUSES } from '@orderloop/core';
import {
  createDb,
  customerAddresses,
  customers,
  documents,
  inboundEmails,
  messages,
  orders,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCart } from '../src/cart/carts';
import { storeDocument } from '../src/connectors';
import { rememberAddress } from '../src/customer-addresses';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';
import { expireAddresses, expirePersonalData } from '../src/retention';
import { eraseDataSubject, exportDataSubject } from '../src/subjects';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;

async function until<T>(fn: () => Promise<T | false>, what: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
});

const order = (o: Partial<OrderInput>): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  lines: [{ sku: 'WID-100', qty: 2 }],
  meta: {},
  ...o,
});

/** Starts an order and brings it to an end: it finishes, or is cancelled where it waits. */
async function finished(input: OrderInput) {
  const { orderId } = await startOrder(env, { flowId: 'tpl-b2b-order', input });
  const s = await until(async () => {
    const s = await state(orderId);
    return s.status !== 'queued' && s.status !== 'running' && s;
  }, 'the order to settle or wait');
  if (!TERMINAL_ORDER_STATUSES.includes(s.status)) await agent(orderId).cancel('test');
  await until(
    async () => TERMINAL_ORDER_STATUSES.includes((await state(orderId)).status),
    'a terminal status',
  );
  return orderId;
}

describe('data subject requests', () => {
  it('exports, then erases, a person from their orders, account, documents and messages', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    await db().insert(customers).values({
      id: 'cus_erin',
      name: 'Erin Example Ltd',
      email: 'Erin@Example.com',
      stripeCustomerId: 'cus_stripe_erin',
    });
    const asCustomer = await finished(
      order({
        customerId: 'cus_erin',
        title: 'PO for Erin Example Ltd',
        meta: {
          shipTo: {
            name: 'Erin',
            line1: '4 Dock Rd',
            city: 'Leeds',
            postalCode: 'LS1 4AP',
            country: 'GB',
          },
        },
      }),
    );
    const asGuest = await finished(
      order({
        title: 'Order for Erin Example',
        contact: { email: 'erin@example.com', name: 'Erin Example', phone: '+1 555 010 0199' },
        meta: {
          shipTo: { name: 'Erin Example', line1: '9 Elm St', country: 'US' },
          note: 'Leave with Erin Example, or call 555 010 0199',
          campaign: 'fall',
        },
      }),
    );
    const someoneElse = await finished(order({ title: 'Order for Sam' }));

    await storeDocument(env, asGuest, 'packing', 'slip.html', '<p>Erin Example, 9 Elm St</p>');
    await db().insert(messages).values({
      id: 'msg_erin',
      orderId: asGuest,
      recipient: 'erin@example.com',
      subject: 'Your order',
      body: 'Hi Erin Example',
      createdAt: 0,
    });
    await db().insert(inboundEmails).values({
      id: 'eml_erin',
      messageId: '<erin@example.com>',
      mailbox: 'orders@example.com',
      sender: 'erin@example.com',
      subject: 'Rejected PO from Erin',
      status: 'rejected',
      receivedAt: 0,
      r2Key: 'inbound/rejected/erin.eml',
    });
    await env.DOCS.put('inbound/rejected/erin.eml', 'From: erin@example.com');

    const exported = await exportDataSubject(env, ' ERIN@example.com ');
    expect(exported.orders.map((o) => o.id).sort()).toEqual([asCustomer, asGuest].sort());
    expect(exported.orders.find((o) => o.id === asGuest)).toMatchObject({
      contact: { name: 'Erin Example' },
      meta: { shipTo: { line1: '9 Elm St' } },
    });
    expect(exported.customers).toMatchObject([{ id: 'cus_erin', name: 'Erin Example Ltd' }]);
    expect(exported.messages.map((m) => m.id)).toEqual(['msg_erin']);
    expect(exported.inboundEmails.map((m) => m.id)).toEqual(['eml_erin']);
    expect(exported.documents.map((d) => d.kind)).toContain('packing');
    // The customer page's address, from the order it started with.
    expect(exported.addresses).toMatchObject([
      { customerId: 'cus_erin', line1: '4 Dock Rd', orders: 1, lastOrderId: asCustomer },
    ]);

    const erased = await eraseDataSubject(env, 'erin@example.com');
    expect(erased).toMatchObject({
      ok: true,
      done: true,
      orders: 2,
      customers: 1,
      messages: 1,
      addresses: 1,
    });
    expect(
      await db()
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.customerId, 'cus_erin')),
    ).toEqual([]);

    const guest = await state(asGuest);
    expect(guest.order!.contact).toBeUndefined();
    expect(guest.order!.title).toBe('Order for [erased]');
    expect(guest.order!.meta).toEqual({
      note: 'Leave with [erased], or call [phone]',
      campaign: 'fall',
    });
    expect(guest.order!.lines.map((l) => l.qty)).toEqual([2]);
    expect(JSON.stringify(guest)).not.toMatch(/Erin|9 Elm|0199/i);
    expect((await state(asCustomer)).order!.title).toBe('PO for [erased]');
    expect((await state(someoneElse)).order!.title).toBe('Order for Sam');

    const row = await db().select().from(orders).where(eq(orders.id, asGuest)).get();
    expect(row).toMatchObject({ contactEmail: null, title: 'Order for [erased]' });
    expect(row!.erasedAt).toBeGreaterThan(0);
    expect(await db().select().from(documents).where(eq(documents.orderId, asGuest))).toEqual([]);
    expect((await env.DOCS.list({ prefix: `orders/${asGuest}/` })).objects).toEqual([]);
    expect(await env.DOCS.get('inbound/rejected/erin.eml')).toBeNull();
    expect(
      await db().select().from(messages).where(eq(messages.id, 'msg_erin')).get(),
    ).toMatchObject({
      recipient: '[erased]',
      body: '[erased]',
    });
    expect(
      await db().select().from(inboundEmails).where(eq(inboundEmails.id, 'eml_erin')).get(),
    ).toMatchObject({ sender: '[erased]', subject: '', r2Key: null });
    expect(
      await db().select().from(customers).where(eq(customers.id, 'cus_erin')).get(),
    ).toMatchObject({
      name: 'Erased customer',
      email: 'erased-cus_erin@erased.invalid',
      stripeCustomerId: null,
    });

    // Nothing is left to find.
    expect(await eraseDataSubject(env, 'erin@example.com')).toMatchObject({ ok: true, orders: 0 });
    expect((await exportDataSubject(env, 'erin@example.com')).orders).toEqual([]);
  });

  it('exports and removes the ship-to on their account’s staff carts', async () => {
    const id = `cus_ship_${crypto.randomUUID().slice(0, 6)}`;
    const email = `${id}@example.com`;
    await db().insert(customers).values({ id, name: 'Shipping Example', email });
    const made = await createCart(env, {
      title: 'Restock',
      flowId: 'tpl-storefront-order',
      customerId: id,
      createdBy: 'usr_1',
    });
    if (!made.ok) throw new Error(made.error);
    const cart = env.CART_AGENT.getByName(made.id);
    const ops = { kind: 'staff' as const, id: 'usr_1', name: 'Ops', role: 'operator' as const };
    const home = {
      name: 'Sam',
      line1: '2 Mill Ln',
      city: 'York',
      postalCode: 'YO1 7HH',
      country: 'GB',
    };
    await cart.applyAs(ops, { op: 'add', sku: 'GSK-010', qty: 1 });
    expect(await cart.applyAs(ops, { op: 'set_ship_to', address: home })).toEqual({ ok: true });

    const exported = await exportDataSubject(env, email);
    expect(exported.carts).toEqual([expect.objectContaining({ id: made.id, shipTo: home })]);

    const erased = await eraseDataSubject(env, email);
    expect(erased).toMatchObject({ ok: true, carts: 1 });
    const after = (await cart.snapshot())!.cart!;
    expect(after.shipTo).toBeNull();
    // Still open, and priced again without it.
    expect(after).toMatchObject({ status: 'open', quotedVersion: after.version });
    expect((await exportDataSubject(env, email)).carts).toEqual([]);
    // Nothing left to remove: a repeat counts no cart.
    expect(await eraseDataSubject(env, email)).toMatchObject({ ok: true, carts: 0 });
  });

  it('keeps one address per place a customer ships to, counting its orders', async () => {
    const customerId = `cus_adr_${crypto.randomUUID().slice(0, 6)}`;
    const place = { line1: '1 Main St', city: 'Springfield', region: 'IL', postalCode: '62701' };
    await rememberAddress(db(), {
      id: 'ord_a1',
      customerId,
      shipTo: { ...place, name: 'Ann', country: 'US' },
      at: 1,
    });
    await rememberAddress(db(), {
      id: 'ord_a2',
      customerId,
      shipTo: { ...place, line1: '1  main st', name: 'Bo', country: 'USA' },
      at: 2,
    });
    // Free text, a guest, and an address missing its city aren't kept.
    await rememberAddress(db(), { id: 'ord_a3', customerId, shipTo: '1 Main St', at: 3 });
    await rememberAddress(db(), { id: 'ord_a4', customerId: null, shipTo: place, at: 4 });
    await rememberAddress(db(), {
      id: 'ord_a5',
      customerId,
      shipTo: { line1: '9 Elm St', postalCode: '62701', country: 'US' },
      at: 5,
    });
    const rows = await db()
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
    expect(rows).toMatchObject([
      {
        name: 'Bo',
        line1: '1 Main St',
        country: 'US',
        orders: 2,
        firstUsedAt: 1,
        lastUsedAt: 2,
        lastOrderId: 'ord_a2',
      },
    ]);
  });

  it('forgets addresses last shipped to before the personal data retention', async () => {
    const customerId = `cus_old_${crypto.randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const at = (line1: string, when: number) =>
      rememberAddress(db(), {
        id: `ord_${line1.slice(0, 1)}`,
        customerId,
        shipTo: { line1, city: 'York', postalCode: 'YO1 7HH', country: 'GB' },
        at: when,
      });
    await at('1 Old Rd', now - 400 * 86_400_000);
    await at('2 New Rd', now - 86_400_000);
    expect(
      await expireAddresses({ ...env, PERSONAL_DATA_RETENTION_DAYS: '' } as unknown as Env, now),
    ).toBe(0);
    const swept = { ...env, PERSONAL_DATA_RETENTION_DAYS: '365' } as unknown as Env;
    expect(await expireAddresses(swept, now)).toBeGreaterThanOrEqual(1);
    const left = await db()
      .select({ line1: customerAddresses.line1 })
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
    expect(left).toEqual([{ line1: '2 New Rd' }]);
  });

  it('refuses while one of their orders is still running', async () => {
    await db().insert(orders).values({
      id: 'ord_busy',
      model: 'b2b',
      status: 'waiting',
      contactEmail: 'busy@example.com',
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(await eraseDataSubject(env, 'busy@example.com')).toEqual({
      ok: false,
      reason: 'active_orders',
      orders: ['ord_busy'],
    });
  });

  it('erases the buyer from orders finished longer ago than the retention, and only those', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const contact = { email: 'old@example.com', name: 'Olive Oldham' };
    const old = await finished(order({ title: 'For Olive Oldham', contact }));
    const recent = await finished(order({ title: 'For Olive Oldham', contact }));
    const now = Date.now();
    await db()
      .update(orders)
      .set({ updatedAt: now - 400 * 86_400_000 })
      .where(eq(orders.id, old));

    expect(
      await expirePersonalData({ ...env, PERSONAL_DATA_RETENTION_DAYS: '' } as unknown as Env, now),
    ).toBe(0);
    const swept = { ...env, PERSONAL_DATA_RETENTION_DAYS: '365' } as unknown as Env;
    expect(await expirePersonalData(swept, now)).toBeGreaterThanOrEqual(1);
    expect((await state(old)).order).toMatchObject({ title: 'For [erased]', contact: undefined });
    expect((await state(recent)).order).toMatchObject({ title: 'For Olive Oldham', contact });
    expect(await expirePersonalData(swept, now)).toBe(0);
  });
});
