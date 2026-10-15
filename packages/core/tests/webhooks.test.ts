import { describe, expect, it } from 'vitest';
import { constantTimeEqual, signWebhook, verifyStripeSignature, verifyWebhook } from '../src';

const secret = 'whsec_test';
const body = JSON.stringify({
  orderId: 'ord_1',
  event: 'payment.received',
  payload: { amount: 10 },
});

describe('webhook signatures', () => {
  it('accepts a fresh, correctly signed body', async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    expect(await verifyWebhook(secret, body, header, { nowSec: 1_000_010 })).toEqual({ ok: true });
  });

  it('rejects a tampered body, a wrong secret and a missing header', async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    const opts = { nowSec: 1_000_000 };
    expect(await verifyWebhook(secret, body.replace('10', '99'), header, opts)).toMatchObject({
      ok: false,
      reason: 'Signature mismatch',
    });
    expect(await verifyWebhook('other', body, header, opts)).toMatchObject({ ok: false });
    expect(await verifyWebhook(secret, body, null, opts)).toMatchObject({
      ok: false,
      reason: 'Missing signature header',
    });
    expect(await verifyWebhook(secret, body, 'garbage', opts)).toMatchObject({
      ok: false,
      reason: 'Malformed signature header',
    });
  });

  it('rejects a replay outside the tolerance window', async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    expect(await verifyWebhook(secret, body, header, { nowSec: 1_000_000 + 301 })).toMatchObject({
      ok: false,
      reason: 'Signature timestamp outside tolerance',
    });
  });
});

describe('several v1 signatures', () => {
  it('passes when any v1 matches, and fails when none does', async () => {
    const good = (await signWebhook(secret, body, 1_000_000)).split('v1=')[1]!;
    const other = (await signWebhook('whsec_old', body, 1_000_000)).split('v1=')[1]!;
    const opts = { nowSec: 1_000_000 };
    expect(await verifyWebhook(secret, body, `t=1000000,v1=${other},v1=${good}`, opts)).toEqual({
      ok: true,
    });
    expect(await verifyWebhook(secret, body, `t=1000000,v1=${good},v1=${other}`, opts)).toEqual({
      ok: true,
    });
    expect(await verifyWebhook('nope', body, `t=1000000,v1=${other},v1=${good}`, opts)).toEqual({
      ok: false,
      reason: 'Signature mismatch',
    });
    expect(await verifyWebhook(secret, body, 't=1000000,v0=abc', opts)).toMatchObject({
      reason: 'Malformed signature header',
    });
  });

  it('compares in constant time, length included', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Stripe-Signature', () => {
  // A header in Stripe's shape: two v1 signatures (a secret being rolled) and a legacy v0.
  const stripeSecret = 'whsec_stripe_fixture';
  const event = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });

  it('verifies a header Stripe sent while a signing secret is rolled', async () => {
    const t = 1_700_000_000;
    const current = (await signWebhook(stripeSecret, event, t)).split('v1=')[1]!;
    const previous = (await signWebhook('whsec_previous', event, t)).split('v1=')[1]!;
    const header = `t=${t},v1=${previous},v1=${current},v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39`;
    expect(await verifyStripeSignature(stripeSecret, event, header, { nowSec: t + 30 })).toEqual({
      ok: true,
    });
    expect(await verifyStripeSignature('whsec_previous', event, header, { nowSec: t })).toEqual({
      ok: true,
    });
    expect(
      await verifyStripeSignature(stripeSecret, `${event} `, header, { nowSec: t }),
    ).toMatchObject({ ok: false, reason: 'Signature mismatch' });
    expect(
      await verifyStripeSignature(stripeSecret, event, header, { nowSec: t + 301 }),
    ).toMatchObject({ ok: false, reason: 'Signature timestamp outside tolerance' });
  });
});
