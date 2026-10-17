import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderState } from '@orderloop/core';
import { payments } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../../src/flows';
import { ucpProfile } from '../../src/ucp/config';
import { installStripeFake, type StripeFake } from '../stripe-fake';
import {
  db,
  enableUcp,
  key,
  monitorCheckout,
  ORIGIN,
  pay,
  platform,
  ucp,
  until,
} from '../ucp-helpers';

let stripe: StripeFake;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});
beforeEach(() => {
  stripe = installStripeFake();
});
afterEach(async () => {
  stripe.restore();
  await introspector?.dispose();
  introspector = undefined;
});

const stripePay = (pm: string, type = 'stripe_payment_method') => pay(pm, 'stripe', type);

describe('UCP checkout with Stripe', () => {
  it('offers the Stripe handler with the publishable key, and not the test one', async () => {
    const profile = (await ucpProfile(env, ORIGIN))!;
    expect(profile.ucp.payment_handlers).toEqual({
      'app.orderloop.stripe': [
        expect.objectContaining({
          id: 'stripe',
          config: { publishable_key: 'pk_test_fake', credential_type: 'stripe_payment_method' },
        }),
      ],
    });
  });

  it('holds the quoted total at completion, and the order adopts and captures that hold', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const alpha = await platform('stripe_alpha');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const total = c.totals.at(-1).amount;
    const done = await ucp(
      alpha,
      'POST',
      `/ucp/v1/checkout-sessions/${c.id}/complete`,
      stripePay('pm_card_visa'),
      { 'idempotency-key': key() },
    );
    expect(done.body.status).toBe('completed');

    const [created] = stripe.callsTo('POST', '/v1/payment_intents');
    expect(created!.params).toMatchObject({
      amount: String(total),
      currency: 'usd',
      capture_method: 'manual',
      payment_method: 'pm_card_visa',
      metadata: { checkout_id: c.id },
    });
    expect(created!.idempotencyKey).toContain(c.id);
    const intentId = [...stripe.intents.keys()][0]!;

    const orderId = done.body.order.id;
    await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the return window');
    // One PaymentIntent: the one completion made, adopted by the flow and then captured.
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(1);
    expect(stripe.intents.get(intentId)!.status).toBe('succeeded');
    const rows = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows.find((r) => r.kind === 'authorization:card')).toMatchObject({
      provider: 'stripe',
      externalId: intentId,
    });
  });

  it('reports a declined card on the checkout and places no order', async () => {
    const alpha = await platform('stripe_beta');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const r = await ucp(
      alpha,
      'POST',
      `/ucp/v1/checkout-sessions/${c.id}/complete`,
      stripePay('pm_card_visa_chargeDeclined'),
      { 'idempotency-key': key() },
    );
    expect(r.body).toMatchObject({
      status: 'ready_for_complete',
      messages: [{ code: 'payment_failed', severity: 'recoverable', path: '$.payment' }],
    });
    expect(r.body).not.toHaveProperty('order');
  });

  it('refuses a credential that is not a Stripe PaymentMethod without calling Stripe', async () => {
    const alpha = await platform('stripe_gamma');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const r = await ucp(
      alpha,
      'POST',
      `/ucp/v1/checkout-sessions/${c.id}/complete`,
      stripePay('tok_visa', 'card_token'),
      { 'idempotency-key': key() },
    );
    expect(r.body.messages[0]).toMatchObject({ code: 'payment_failed' });
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(0);
  });
});
