import { signWebhook } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { STRIPE_WEBHOOK_SECRET: 'whsec_test' as string | undefined };
const paymentEvent = vi.fn();

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ paymentEvent }) }));

const { handleStripeWebhook } = await import('~/lib/stripe.server');

const paid = {
  id: 'evt_1',
  object: 'event',
  type: 'invoice.paid',
  data: { object: { id: 'in_1', object: 'invoice', amount_paid: 1000, currency: 'usd' } },
};

async function fromStripe(body: unknown, opts: { secret?: string; header?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const header = opts.header ?? (await signWebhook(opts.secret ?? 'whsec_test', raw));
  return handleStripeWebhook(
    new Request('https://app.test/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      body: raw,
    }),
  );
}

describe('Stripe webhook', () => {
  beforeEach(() => {
    paymentEvent.mockReset();
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('hands a verified event to the engine', async () => {
    paymentEvent.mockResolvedValueOnce({ outcome: 'handled', orderId: 'ord_1' });
    const res = await fromStripe(paid);
    expect(res.status).toBe(200);
    expect(paymentEvent).toHaveBeenCalledWith({
      provider: 'stripe',
      id: 'evt_1',
      type: 'invoice.paid',
      data: { object: paid.data.object },
    });
  });

  it('accepts any of several v1 signatures, as Stripe sends while a secret is rolled', async () => {
    paymentEvent.mockResolvedValueOnce({ outcome: 'duplicate' });
    const raw = JSON.stringify(paid);
    const t = Math.floor(Date.now() / 1000);
    const sig = async (secret: string) => (await signWebhook(secret, raw, t)).split('v1=')[1];
    const header = `t=${t},v1=${await sig('whsec_old')},v1=${await sig('whsec_test')}`;
    expect((await fromStripe(raw, { header })).status).toBe(200);
  });

  it('refuses a bad signature with 400, without calling the engine', async () => {
    expect((await fromStripe(paid, { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await fromStripe(paid, { header: '' })).status).toBe(400);
    expect(paymentEvent).not.toHaveBeenCalled();
  });

  it('answers 409 when the order is not waiting yet, so Stripe retries', async () => {
    paymentEvent.mockResolvedValueOnce({ outcome: 'retry', orderId: 'ord_1' });
    const res = await fromStripe(paid);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ outcome: 'retry' });
  });

  it('answers 503 until the secret is set', async () => {
    env.STRIPE_WEBHOOK_SECRET = undefined;
    expect((await fromStripe(paid)).status).toBe(503);
    expect(paymentEvent).not.toHaveBeenCalled();
  });

  it('answers 400 for a signed body that is not an event, and 500 when the engine fails', async () => {
    expect((await fromStripe({ hello: 'world' })).status).toBe(400);
    paymentEvent.mockRejectedValueOnce(new Error('engine down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await fromStripe(paid)).status).toBe(500);
  });
});
