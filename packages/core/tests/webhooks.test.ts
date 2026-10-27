import { describe, expect, it } from 'vitest';
import {
  CART_EVENT_RETRIES,
  CART_EVENTS,
  cartEventRetryDelaySec,
  constantTimeEqual,
  isCartEvent,
  isWebhookUrl,
  NODE_EVENTS,
  ORDER_EVENTS,
  OUTBOUND_EVENTS,
  pluginManifestSchema,
  signWebhook,
  verifyStripeSignature,
  verifyWebhook,
} from '../src';

const secret = 'whsec_test';
const body = JSON.stringify({
  orderId: 'ord_1',
  event: 'payment.received',
  payload: { amount: 10 },
});

describe('webhook signatures', () => {
  it('accepts a fresh, correctly signed body', async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    expect(await verifyWebhook(secret, body, header, { nowSec: 1_000_010 })).toMatchObject({
      ok: true,
    });
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
  it('signs with each secret during a rotation, so either one verifies', async () => {
    const header = await signWebhook([secret, 'whsec_old'], body, 1_000_000);
    expect(header.match(/v1=/g)).toHaveLength(2);
    const opts = { nowSec: 1_000_000 };
    expect(await verifyWebhook(secret, body, header, opts)).toMatchObject({ ok: true });
    expect(await verifyWebhook('whsec_old', body, header, opts)).toMatchObject({ ok: true });
  });

  it('passes when any v1 matches, and fails when none does', async () => {
    const good = (await signWebhook(secret, body, 1_000_000)).split('v1=')[1]!;
    const other = (await signWebhook('whsec_old', body, 1_000_000)).split('v1=')[1]!;
    const opts = { nowSec: 1_000_000 };
    // The signature that matched, as computed here: the same however the header spells it.
    expect(await verifyWebhook(secret, body, `t=1000000,v1=${other},v1=${good}`, opts)).toEqual({
      ok: true,
      signature: good,
      t: 1_000_000,
    });
    expect(await verifyWebhook(secret, body, `t=1000000,v1=${good.toUpperCase()}`, opts)).toEqual({
      ok: true,
      signature: good,
      t: 1_000_000,
    });
    expect(
      await verifyWebhook(secret, body, `t=1000000,v1=${good},v1=${other}`, opts),
    ).toMatchObject({
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
    expect(
      await verifyStripeSignature(stripeSecret, event, header, { nowSec: t + 30 }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await verifyStripeSignature('whsec_previous', event, header, { nowSec: t }),
    ).toMatchObject({
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

describe('where a webhook may go', () => {
  it('is where a delivery may reach, so a bad URL is refused when it is registered', () => {
    expect(isWebhookUrl('https://hooks.example.com/orderloop')).toBe(true);
    expect(isWebhookUrl('http://localhost:8787/hook')).toBe(true);
    for (const url of [
      'http://hooks.example.com/',
      'https://203.0.113.5/',
      'https://erp.internal/',
      'https://x.nip.io/',
      'https://localhost./',
    ])
      expect(isWebhookUrl(url), url).toBe(false);
  });
});

describe('outbound events', () => {
  it('are the order events and then the cart lifecycle, without a cart change event', () => {
    expect(OUTBOUND_EVENTS).toEqual([...ORDER_EVENTS, ...CART_EVENTS]);
    expect(CART_EVENTS).toEqual([
      'cart.created',
      'cart.submitted',
      'cart.returned',
      'cart.canceled',
      'cart.expired',
    ]);
    expect(new Set(OUTBOUND_EVENTS).size).toBe(OUTBOUND_EVENTS.length);
    expect(OUTBOUND_EVENTS).not.toContain('cart.changed');
    expect(CART_EVENTS.every(isCartEvent)).toBe(true);
    expect(ORDER_EVENTS.some(isCartEvent)).toBe(false);
    // Nodes announce only order events; carts announce their own.
    expect(Object.values(NODE_EVENTS).every((e) => !isCartEvent(e.event))).toBe(true);
  });

  it('can be subscribed to by a plugin, cart events included', () => {
    const base = { apiVersion: 1, id: 'acme', name: 'Acme', version: '1' };
    expect(pluginManifestSchema.parse({ ...base, events: ['cart.submitted'] }).events).toEqual([
      'cart.submitted',
    ]);
    expect(() => pluginManifestSchema.parse({ ...base, events: ['cart.changed'] })).toThrow();
  });

  it('retry a cart event for about a day, from ten seconds doubling to an hour', () => {
    expect([0, 1, 5, 8, 9, 20].map(cartEventRetryDelaySec)).toEqual([
      10, 20, 320, 2560, 3600, 3600,
    ]);
    let total = 0;
    for (let n = 0; n < CART_EVENT_RETRIES; n++) total += cartEventRetryDelaySec(n);
    expect(total / 3600).toBeGreaterThan(23);
    expect(total / 3600).toBeLessThan(25);
  });
});
