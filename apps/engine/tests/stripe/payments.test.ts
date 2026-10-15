import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Order, OrderInput, OrderState } from '@orderloop/core';
import { createDb, customers, payments } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import {
  authorizePayment,
  capturePayment,
  charge,
  refund,
  voidAuthorizations,
} from '../../src/payments';
import { encodeForm, STRIPE_API_VERSION } from '../../src/stripe';
import { installStripeFake, parseForm, type StripeFake } from '../stripe-fake';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;
const rows = (orderId: string) =>
  db().select().from(payments).where(eq(payments.orderId, orderId)).all();

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string) =>
  until(async () => {
    const s = await state(id);
    return pred(s) ? s : false;
  }, what);
const settled = (id: string) =>
  waitingOn(
    id,
    (s) => ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'].includes(s.status),
    'a terminal status',
  );

const input = (o: Partial<OrderInput> & Pick<OrderInput, 'model'>): OrderInput => ({
  channel: 'api',
  currency: 'USD',
  lines: [],
  meta: {},
  ...o,
});
const order = (id: string, o: Partial<Order> = {}): Order => ({
  ...input({ model: 'b2c', customerId: 'cus_ada' }),
  id,
  createdAt: Date.now(),
  subtotal: 40,
  shipping: 0,
  tax: 0,
  total: 40,
  ...o,
});

let stripe: StripeFake;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

async function introspect(timeouts: string[] = []) {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    for (const name of timeouts) await m.forceEventTimeout({ name });
  });
}

beforeAll(async () => {
  await ensureTemplates(env);
});
beforeEach(async () => {
  stripe = installStripeFake();
  // Each test gets a fresh Stripe, so no account may point at a customer from an earlier one.
  await db().update(customers).set({ stripeCustomerId: null, stripePaymentMethodId: null });
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
  stripe.restore();
});

describe('Stripe client', () => {
  it('nests parameters the way Stripe reads them', () => {
    const body = encodeForm({
      amount: 1234,
      confirm: true,
      customer: undefined,
      metadata: { order_id: 'ord_1', step: 'pay#1' },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      expand: ['latest_charge'],
    });
    expect(decodeURIComponent(body)).toBe(
      'amount=1234&confirm=true&metadata[order_id]=ord_1&metadata[step]=pay#1&automatic_payment_methods[enabled]=true&automatic_payment_methods[allow_redirects]=never&expand[0]=latest_charge',
    );
    expect(parseForm(body)).toMatchObject({ metadata: { order_id: 'ord_1' } });
  });
});

describe('authorize and capture', () => {
  it('holds the total, then captures it, pinning the API version and keying every write', async () => {
    const o = order('ord_s_capture', { total: 12.34, subtotal: 12.34 });
    const auth = await authorizePayment(env, o, 'authorize#1', 'card');
    expect(auth).toMatchObject({ status: 'authorized', amount: 12.34 });
    const pi = stripe.intents.get(auth.intentId!)!;
    expect(pi).toMatchObject({
      amount: 1234,
      currency: 'usd',
      capture_method: 'manual',
      status: 'requires_capture',
      metadata: { order_id: 'ord_s_capture', step: 'authorize#1' },
    });
    const create = stripe.callsTo('POST', '/v1/payment_intents')[0]!;
    expect(create.idempotencyKey).toBe(auth.paymentId);
    expect(create.version).toBe(STRIPE_API_VERSION);
    expect(create.auth).toBe('Bearer sk_test_fake');

    const cap = await capturePayment(env, o, 'capture#1');
    expect(cap).toMatchObject({ status: 'succeeded', amount: 12.34 });
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received).toBe(1234);
    const saved = await rows('ord_s_capture');
    expect(saved.map((r) => [r.kind, r.status, r.provider, r.externalId, r.currency])).toEqual(
      expect.arrayContaining([
        ['authorization:card', 'captured', 'stripe', pi.id, 'USD'],
        ['capture', 'succeeded', 'stripe', pi.id, 'USD'],
      ]),
    );
    // A retried capture step neither captures again nor fails.
    expect(await capturePayment(env, o, 'capture#1')).toEqual(cap);
    expect(stripe.callsTo('POST', /\/capture$/)).toHaveLength(1);
  });

  it('creates one PaymentIntent when a retry follows a lost response', async () => {
    const o = order('ord_s_retry');
    stripe.loseNextResponse(/^\/v1\/payment_intents$/);
    await expect(authorizePayment(env, o, 'authorize#1', 'card')).rejects.toThrow(
      'Network connection lost',
    );
    expect(await rows('ord_s_retry')).toHaveLength(0);
    const auth = await authorizePayment(env, o, 'authorize#1', 'card');
    expect(auth.status).toBe('authorized');
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(2);
    expect(stripe.intents.size).toBe(1);
    expect((await rows('ord_s_retry')).map((r) => r.externalId)).toEqual([auth.intentId]);
  });

  it('throws on a Stripe outage so the step retries, recording nothing', async () => {
    const o = order('ord_s_outage');
    stripe.failNext(/^\/v1\/payment_intents$/);
    await expect(authorizePayment(env, o, 'authorize#1', 'card')).rejects.toMatchObject({
      name: 'StripeError',
      status: 500,
    });
    expect(await rows('ord_s_outage')).toHaveLength(0);
    expect((await authorizePayment(env, o, 'authorize#1', 'card')).status).toBe('authorized');
  });

  it('takes the declined branch on a card error, with the decline code', async () => {
    const o = order('ord_s_decline', { meta: { simulate: 'payment_decline' } });
    const auth = await authorizePayment(env, o, 'authorize#1', 'card');
    expect(auth).toMatchObject({ status: 'declined', reason: 'generic_decline' });
    expect(stripe.calls[0]!.params.payment_method).toBe('pm_card_visa_chargeDeclined');
    const [row] = await rows('ord_s_decline');
    expect(row).toMatchObject({ status: 'declined', provider: 'stripe', ref: 'generic_decline' });
  });

  it('adopts a PaymentIntent made elsewhere, and declines one that does not match', async () => {
    const good = stripe.authorizedIntent(4000);
    const o = order('ord_s_adopt', { payment: { provider: 'stripe', intentId: good.id } });
    const auth = await authorizePayment(env, o, 'authorize#1', 'card');
    expect(auth).toMatchObject({ status: 'authorized', intentId: good.id });
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(0);
    await capturePayment(env, o, 'capture#1');
    expect(stripe.intents.get(good.id)!.status).toBe('succeeded');

    // The same intent cannot pay a second order.
    const twice = await authorizePayment(
      env,
      order('ord_s_adopt2', { payment: { provider: 'stripe', intentId: good.id } }),
      'authorize#1',
      'card',
    );
    expect(twice.status).toBe('declined');

    const short = stripe.authorizedIntent(3999);
    const mismatch = await authorizePayment(
      env,
      order('ord_s_mismatch', { payment: { provider: 'stripe', intentId: short.id } }),
      'authorize#1',
      'card',
    );
    expect(mismatch).toMatchObject({ status: 'declined', intentId: short.id });
    expect(mismatch.reason).toMatch(/3999.*4000/);
    expect(stripe.intents.get(short.id)!.status).toBe('requires_capture');

    const euros = stripe.authorizedIntent(4000, 'eur');
    const wrong = await authorizePayment(
      env,
      order('ord_s_currency', { payment: { provider: 'stripe', intentId: euros.id } }),
      'authorize#1',
      'card',
    );
    expect(wrong.reason).toMatch(/EUR/);
  });

  it('records payments the channel or the till took without calling Stripe', async () => {
    const shop = order('ord_s_external', { payment: { provider: 'external', reference: '1001' } });
    expect((await authorizePayment(env, shop, 'authorize#1', 'card')).status).toBe('authorized');
    expect((await capturePayment(env, shop, 'capture#1')).status).toBe('succeeded');
    const till = order('ord_s_till');
    expect((await authorizePayment(env, till, 'authorize#1', 'card_present')).status).toBe(
      'authorized',
    );
    expect(stripe.calls).toHaveLength(0);
    expect((await rows('ord_s_external')).every((r) => r.provider === 'external')).toBe(true);
    expect((await rows('ord_s_till'))[0]!.provider).toBe('offline');
  });

  it('fails for good when Stripe mode has no key', async () => {
    const noKey = { ...env, STRIPE_SECRET_KEY: undefined } as Env;
    await expect(
      authorizePayment(noKey, order('ord_s_nokey'), 'authorize#1', 'card'),
    ).rejects.toMatchObject({ message: expect.stringMatching(/STRIPE_SECRET_KEY/) });
    expect(stripe.calls).toHaveLength(0);
  });
});

describe('void', () => {
  it('cancels the intent before marking the row, and counts an already-canceled one', async () => {
    const o = order('ord_s_void');
    const auth = await authorizePayment(env, o, 'authorize#1', 'card');
    stripe.failNext(/\/cancel$/);
    await expect(voidAuthorizations(env, o.id)).rejects.toThrow();
    expect((await rows(o.id))[0]!.status).toBe('authorized');
    expect(await voidAuthorizations(env, o.id)).toBe(1);
    expect(stripe.intents.get(auth.intentId!)!.status).toBe('canceled');
    expect((await rows(o.id))[0]!.status).toBe('voided');
    expect(await voidAuthorizations(env, o.id)).toBe(0);

    // Canceled in Stripe by an earlier attempt whose D1 write never landed.
    const again = order('ord_s_void2');
    const a2 = await authorizePayment(env, again, 'authorize#1', 'card');
    stripe.intents.get(a2.intentId!)!.status = 'canceled';
    expect(await voidAuthorizations(env, again.id)).toBe(1);
  });

  it('leaves an intent that was captured to the capture', async () => {
    const o = order('ord_s_race');
    const auth = await authorizePayment(env, o, 'authorize#1', 'card');
    stripe.intents.get(auth.intentId!)!.status = 'succeeded';
    expect(await voidAuthorizations(env, o.id)).toBe(0);
    expect((await rows(o.id))[0]!.status).toBe('authorized');
    stripe.intents.get(auth.intentId!)!.status = 'canceled';
    expect((await capturePayment(env, o, 'capture#1')).status).toBe('failed');
  });
});

describe('verify and charge', () => {
  it('verifies and saves the card, releasing the hold, then charges it off-session', async () => {
    const o = order('ord_s_sub');
    const v = await authorizePayment(env, o, 'authorize#1', 'card', 'verify');
    expect(v.status).toBe('verified');
    const pi = stripe.intents.get(v.intentId!)!;
    expect(pi).toMatchObject({ status: 'canceled', setup_future_usage: 'off_session' });
    const ada = await db().select().from(customers).where(eq(customers.id, 'cus_ada')).get();
    expect(ada!.stripeCustomerId).toBe(pi.customer);
    expect(ada!.stripePaymentMethodId).toBe('pm_card_visa');
    expect(stripe.customers.size).toBe(1);
    // A verification is not an open hold: nothing to void.
    expect(await voidAuthorizations(env, o.id)).toBe(0);

    const c = await charge(env, o, 'charge#1');
    expect(c.status).toBe('succeeded');
    const renewal = stripe.intents.get(c.intentId!)!;
    expect(renewal).toMatchObject({
      status: 'succeeded',
      customer: ada!.stripeCustomerId,
      off_session: true,
      amount: 4000,
    });
    // A second verify reuses the Stripe customer.
    await authorizePayment(env, order('ord_s_sub2'), 'authorize#1', 'card', 'verify');
    expect(stripe.customers.size).toBe(1);
  });

  it('fails a charge the card declines', async () => {
    const c = await charge(
      env,
      order('ord_s_chg_fail', { meta: { simulate: 'charge_fail' } }),
      'charge#1',
    );
    expect(c).toMatchObject({ status: 'failed', reason: 'generic_decline' });
  });
});

describe('refund', () => {
  it('spreads a refund over the payments newest first, once per step', async () => {
    const o = order('ord_s_refund', { total: 30, subtotal: 30 });
    const first = await charge(env, o, 'charge#1');
    await new Promise((r) => setTimeout(r, 5));
    const second = await charge(env, { ...o, total: 20 }, 'charge#2');

    const part = await refund(env, o, 'refund#1', 15);
    expect(part).toMatchObject({ status: 'succeeded', amount: 15 });
    expect(stripe.intents.get(second.intentId!)!.refunded).toBe(1500);
    expect(stripe.intents.get(first.intentId!)!.refunded).toBe(0);

    const rest = await refund(env, o, 'refund#2');
    expect(rest.amount).toBe(35);
    expect(stripe.intents.get(second.intentId!)!.refunded).toBe(2000);
    expect(stripe.intents.get(first.intentId!)!.refunded).toBe(3000);
    const parts = (await rows(o.id)).filter((r) => r.kind === 'refund');
    expect(
      parts.map((r) => [r.id.replace(/^rfd_ord_s_refund_/, ''), r.amount, r.ref]).sort(),
    ).toEqual([
      ['refund_1', 15, second.paymentId],
      ['refund_2', 5, second.paymentId],
      ['refund_2_1', 30, first.paymentId],
    ]);

    // A retried step changes nothing.
    const calls = stripe.callsTo('POST', '/v1/refunds').length;
    expect(await refund(env, o, 'refund#2')).toEqual(rest);
    expect(stripe.callsTo('POST', '/v1/refunds')).toHaveLength(calls);
    expect(await refund(env, o, 'refund#3')).toMatchObject({ status: 'failed', amount: 0 });
  });
});

describe('orders through Stripe', () => {
  const marketplace = (
    lines = [
      { sku: 'HP-200', qty: 1 },
      { sku: 'KET-01', qty: 2 },
    ],
  ) =>
    startOrder(env, {
      flowId: 'tpl-marketplace-order',
      input: input({ model: 'marketplace', channel: 'marketplace', customerId: 'cus_ada', lines }),
    });
  const awaitingSeller = (orderId: string) =>
    waitingOn(orderId, (s) => s.waits.some((w) => w.event === 'seller.responded'), 'seller wait');

  it('captures only what the sellers accepted', async () => {
    await introspect(['window#1']);
    const { orderId } = await marketplace();
    await awaitingSeller(orderId);
    await agent(orderId).deliver('seller.responded', {
      sellerId: 'sel_kettle',
      decision: 'rejected',
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    const auth = (await rows(orderId)).find((r) => r.kind.startsWith('authorization'))!;
    const pi = stripe.intents.get(auth.externalId!)!;
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received).toBe(Math.round(done.order!.total * 100));
    expect(pi.amount_received).toBeLessThan(pi.amount);
  });

  it('cancels the intent when the order is cancelled', async () => {
    await introspect();
    const { orderId } = await marketplace();
    await awaitingSeller(orderId);
    const auth = (await rows(orderId)).find((r) => r.kind.startsWith('authorization'))!;
    expect(stripe.intents.get(auth.externalId!)!.status).toBe('requires_capture');
    await agent(orderId).cancel('Changed my mind');
    expect((await state(orderId)).status).toBe('cancelled');
    expect(stripe.intents.get(auth.externalId!)!.status).toBe('canceled');
    expect((await rows(orderId))[0]!.status).toBe('voided');
  });

  it('cancels the intent when the order fails and rolls back', async () => {
    await introspect(['responded#1']);
    const { orderId } = await marketplace([{ sku: 'KET-01', qty: 1 }]);
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    const voided = await until(async () => {
      const r = await rows(orderId);
      return r.length > 0 && r.every((p) => p.status === 'voided') && r;
    }, 'the void');
    expect(stripe.intents.get(voided[0]!.externalId!)!.status).toBe('canceled');
  });

  it('ends a declined card on the declined branch without a hold', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 4 }],
        meta: { simulate: 'payment_decline' },
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    expect(done.reason).toBe('Card declined');
    expect(done.timeline.some((t) => t.message.endsWith('Declined: generic_decline'))).toBe(true);
    expect((await rows(orderId)).map((r) => [r.status, r.ref])).toEqual([
      ['declined', 'generic_decline'],
    ]);
    expect([...stripe.intents.values()].some((p) => p.status === 'requires_capture')).toBe(false);
  });

  it('verifies a subscription’s card, leaves no hold, and charges renewals off-session', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-subscription',
      input: input({
        model: 'subscription',
        customerId: 'cus_ada',
        lines: [{ sku: 'SUB-BOX', qty: 1 }],
        meta: { simulate: 'charge_fail' },
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.reason).toBe('Renewal payment failed');
    const pays = await rows(orderId);
    expect(pays.map((p) => p.status).sort()).toEqual(['failed', 'failed', 'verified']);
    const verify = pays.find((p) => p.status === 'verified')!;
    expect(stripe.intents.get(verify.externalId!)!.status).toBe('canceled');
    const renewals = pays.filter((p) => p.kind === 'charge');
    for (const r of renewals) {
      const pi = stripe.intents.get(r.externalId!)!;
      expect(pi).toMatchObject({ off_session: true, customer: expect.stringMatching(/^cus_/) });
    }
  });
});
