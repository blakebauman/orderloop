import { describe, expect, it } from 'vitest';
import { EMPTY_ORDER_STATE, type OrderState } from '../src/api';
import { eraseOrderState, eraseText, erasureTerms, subjectEmail } from '../src/erasure';

describe('erasure', () => {
  it('matches a subject by their trimmed, lower-cased email', () => {
    expect(subjectEmail('  Jane@Example.COM ')).toBe('jane@example.com');
  });

  it('erases longer names first and skips very short ones', () => {
    const terms = erasureTerms(['Jane', 'Jane Doe', 'Al', null, ' ']);
    expect(terms).toEqual(['Jane Doe', 'Jane']);
    expect(eraseText('Jane Doe and jane, with Al', terms)).toBe('[erased] and [erased], with Al');
  });

  it('erases the buyer from an order and keeps the commercial record', () => {
    const state: OrderState = {
      ...EMPTY_ORDER_STATE,
      orderId: 'ord_1',
      status: 'completed',
      order: {
        id: 'ord_1',
        createdAt: 0,
        model: 'b2c',
        channel: 'web',
        currency: 'USD',
        title: 'Gift for Jane Doe',
        contact: { email: 'jane@example.com', name: 'Jane Doe' },
        documentText: 'Ship to Jane Doe',
        lines: [{ sku: 'MON-27', qty: 1, unitPrice: 300 }],
        meta: { shipTo: { name: 'Jane Doe', line1: '1 Main St' }, giftNote: 'Love, Sam' },
        subtotal: 300,
        shipping: 0,
        tax: 0,
        total: 300,
      },
      vars: { notifyTo: 'jane@example.com', risk: 10 },
      nodes: {
        notify: {
          status: 'succeeded',
          runs: 1,
          summary: 'Emailed Jane Doe',
          output: { email: 'x' },
        },
      },
      timeline: [{ at: 0, kind: 'node', message: 'Sent receipt to jane@example.com' }],
      reason: undefined,
    };
    const erased = eraseOrderState(state, ['Sam']);
    expect(erased.order).toMatchObject({
      title: 'Gift for [erased]',
      contact: undefined,
      documentText: undefined,
      meta: { giftNote: 'Love, [erased]' },
      lines: [{ sku: 'MON-27', qty: 1, unitPrice: 300 }],
      total: 300,
    });
    expect(erased.vars).toEqual({ notifyTo: '[email]', risk: 10 });
    expect(erased.nodes.notify).toMatchObject({ summary: 'Emailed [erased]', output: {} });
    expect(erased.timeline[0]!.message).toBe('Sent receipt to [erased]');
    expect(erased.status).toBe('completed');
  });
});
