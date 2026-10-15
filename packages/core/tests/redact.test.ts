import { describe, expect, it } from 'vitest';
import {
  maskPersonalText,
  modelContext,
  modelCustomer,
  modelOrder,
  personalDataMode,
  scrubPersonal,
} from '../src/redact';
import type { Order } from '../src/types';

const order: Order = {
  id: 'ord_1',
  createdAt: 0,
  model: 'b2c',
  channel: 'web',
  title: 'Order for jane@example.com',
  currency: 'USD',
  lines: [{ sku: 'MON-27', name: '27" monitor', qty: 2, unitPrice: 300 }],
  contact: { email: 'jane@example.com', name: 'Jane Doe', phone: '+1 555 010 0199' },
  fulfillment: { method: 'ship', locationId: 'loc_1' },
  payment: { provider: 'stripe', paymentMethodId: 'pm_123' },
  documentText: 'Please ship to 1 Main St. Call 555-010-0199.',
  meta: {
    shipTo: { name: 'Jane Doe', line1: '1 Main St', city: 'Springfield', country: 'US' },
    giftNote: 'Happy birthday! Text me at 555 010 0199',
    source: { email: 'jane@example.com', campaign: 'fall' },
  },
  subtotal: 600,
  shipping: 10,
  tax: 50,
  total: 660,
  baseTotal: 660,
};

const customer = {
  id: 'cus_1',
  name: 'Acme Corp',
  email: 'ap@acme.example',
  kind: 'business',
  tier: 'gold',
  creditLimit: 5000,
  balance: 100,
  terms: 'net_30',
  stripeCustomerId: 'cus_stripe',
};

describe('what a model sees of an order', () => {
  it('redacts by default: no contact, address, document, payment or personal text', () => {
    expect(personalDataMode(undefined)).toBe('redact');
    const seen = modelOrder(order, 'redact');
    const text = JSON.stringify(seen);
    for (const leak of [
      'jane@example.com',
      'Jane Doe',
      '1 Main St',
      'Springfield',
      '0199',
      'pm_123',
    ])
      expect(text).not.toContain(leak);
    expect(seen).toMatchObject({
      guest: true,
      shipToCountry: 'US',
      title: 'Order for [email]',
      fulfillment: { method: 'ship' },
      lines: [{ sku: 'MON-27', name: '27" monitor', qty: 2 }],
      meta: { giftNote: 'Happy birthday! Text me at [phone]', source: { campaign: 'fall' } },
      total: 660,
    });
    expect(text).not.toContain('documentText');
  });

  it('marks a guest checkout without saying who', () => {
    expect(modelOrder({ ...order, customerId: undefined }, 'redact')).toMatchObject({
      guest: true,
    });
    expect(modelOrder({ ...order, customerId: 'cus_1' }, 'redact')).toMatchObject({ guest: false });
  });

  it('sends contact and meta when the deployment says send, but never the document or payment ids', () => {
    expect(personalDataMode('send')).toBe('send');
    const seen = modelOrder(order, 'send');
    expect(seen).toMatchObject({ contact: order.contact, meta: order.meta });
    const text = JSON.stringify(seen);
    expect(text).not.toContain('pm_123');
    expect(text).not.toContain('documentText');
  });

  it("keeps a customer's account terms, and their name and email only with send", () => {
    expect(modelCustomer(customer, 'redact')).toEqual({
      id: 'cus_1',
      kind: 'business',
      tier: 'gold',
      creditLimit: 5000,
      balance: 100,
      terms: 'net_30',
    });
    expect(modelCustomer(customer, 'send')).toMatchObject({
      name: 'Acme Corp',
      email: 'ap@acme.example',
    });
    expect(JSON.stringify(modelCustomer(customer, 'send'))).not.toContain('cus_stripe');
  });

  it('scrubs vars and step outputs, and leaves out what was not asked for', () => {
    const c = modelContext('redact', {
      order,
      vars: { approver: 'boss@example.com', risk: 12 },
      completed: { validate: { output: { shipTo: { line1: '1 Main St' }, ok: true } } },
    });
    expect(c).toEqual({
      order: expect.any(Object),
      vars: { approver: '[email]', risk: 12 },
      completed: { validate: { output: { ok: true } } },
    });
    expect(modelContext('redact', { order })).not.toHaveProperty('customer');
  });
});

describe('masking personal text', () => {
  it('masks emails and phone numbers but not ordinary numbers', () => {
    expect(maskPersonalText('Mail a.b+c@mail.example.co or call +1 (555) 010-0199')).toBe(
      'Mail [email] or call [phone]',
    );
    expect(maskPersonalText('PO 4500123, qty 250, total 1,200.50, due 2026-10-15')).toBe(
      'PO 4500123, qty 250, total 1,200.50, due 2026-10-15',
    );
    expect(scrubPersonal({ Ship_To: { x: 1 }, keep: ['ok'] })).toEqual({ keep: ['ok'] });
  });
});
