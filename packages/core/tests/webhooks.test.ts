import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '../src';

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
