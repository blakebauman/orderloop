import { describe, expect, it } from 'vitest';
import {
  allowsEvent,
  allowsOrder,
  type IntegrationScope,
  newWebhookSecret,
  ROTATION_GRACE_MS,
  signatureKeyId,
  signWebhook,
  verificationSecrets,
  verifyWebhook,
} from '../src';

const payments: IntegrationScope = {
  events: ['payment.received'],
  startOrders: false,
  flows: [],
  channel: null,
};
const storefront: IntegrationScope = {
  events: ['*'],
  startOrders: true,
  flows: ['tpl-storefront-order'],
  channel: 'web',
};

describe('integration scopes', () => {
  it('lets a payment provider deliver its event and nothing else', () => {
    expect(allowsEvent(payments, 'payment.received', 'api')).toEqual({ ok: true });
    expect(allowsEvent(payments, 'shipment.delivered', 'api')).toMatchObject({ ok: false });
    expect(allowsOrder(payments, { channel: 'web' })).toMatchObject({
      ok: false,
      reason: 'This integration may not start orders',
    });
  });

  it('keeps a channel-bound key to its own channel', () => {
    expect(allowsEvent(storefront, 'payment.received', 'web')).toEqual({ ok: true });
    expect(allowsEvent(storefront, 'payment.received', 'pos')).toMatchObject({ ok: false });
    expect(allowsOrder(storefront, { channel: 'web' })).toEqual({ ok: true });
    expect(allowsOrder(storefront, { channel: 'pos' })).toMatchObject({ ok: false });
  });

  it('lets an order name only the flows the key allows', () => {
    expect(allowsOrder(storefront, { channel: 'web', flowId: 'tpl-storefront-order' })).toEqual({
      ok: true,
    });
    expect(allowsOrder(storefront, { channel: 'web', flowId: 'tpl-b2b-order' })).toMatchObject({
      ok: false,
    });
    expect(
      allowsOrder({ ...storefront, flows: ['*'] }, { channel: 'web', flowId: 'tpl-b2b-order' }),
    ).toEqual({ ok: true });
  });
});

describe('rotation', () => {
  const now = 1_800_000_000_000;
  const key = { secret: 'new', previousSecret: 'old', previousExpiresAt: now + ROTATION_GRACE_MS };

  it('accepts the previous secret until it expires', () => {
    expect(verificationSecrets(key, now)).toEqual(['new', 'old']);
    expect(verificationSecrets(key, now + ROTATION_GRACE_MS + 1)).toEqual(['new']);
    expect(
      verificationSecrets({ secret: 'new', previousSecret: null, previousExpiresAt: null }),
    ).toEqual(['new']);
  });

  it('verifies a signature made with either secret', async () => {
    const body = '{"orderId":"ord_1"}';
    const header = await signWebhook('old', body, 1_000_000, 'int_1');
    const opts = { nowSec: 1_000_010 };
    expect(await verifyWebhook(['new', 'old'], body, header, opts)).toMatchObject({ ok: true });
    expect(await verifyWebhook(['new'], body, header, opts)).toMatchObject({ ok: false });
  });
});

describe('key ids', () => {
  it('reads the integration a signature names', async () => {
    expect(signatureKeyId(await signWebhook('s', 'b', 1, 'int_abc'))).toBe('int_abc');
    expect(signatureKeyId(await signWebhook('s', 'b', 1))).toBeUndefined();
    expect(signatureKeyId(null)).toBeUndefined();
  });

  it('makes distinct whsec_ secrets', () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(newWebhookSecret()).not.toBe(a);
  });
});
