import { EMPTY_ORDER_STATE, type OrderState } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { approvalContext } from '../app/lib/approvals';

const state = (currency: string, total: number, fxRate: number): OrderState => ({
  ...EMPTY_ORDER_STATE,
  orderId: 'ord_fx',
  order: {
    id: 'ord_fx',
    model: 'b2b',
    channel: 'api',
    customerId: 'cus_fx',
    currency,
    lines: [],
    meta: {},
    createdAt: 0,
    subtotal: total,
    tax: 0,
    total,
    fxRate,
    baseTotal: Math.round((total / fxRate) * 100) / 100,
  },
  flow: {
    id: 'f',
    name: 'f',
    description: '',
    model: 'b2b',
    channels: [],
    version: 1,
    publishedAt: 0,
    nodes: [
      {
        id: 'credit',
        type: 'commerce.credit_check',
        label: 'Credit',
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'ok',
        type: 'control.approval',
        label: 'Approve',
        config: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [
      { id: 'e', source: 'credit', target: 'ok', sourceHandle: 'over_limit', targetHandle: null },
    ],
  },
  nodes: {
    credit: {
      status: 'succeeded',
      runs: 1,
      branches: ['over_limit'],
      output: { limit: 100_000, balance: 12_000, available: 88_000, currency: 'USD' },
    },
  },
});

describe('approvalContext', () => {
  it('states credit in the base currency and the order in its own', () => {
    const ctx = approvalContext(state('GBP', 85_000, 0.79), 'ok');
    expect(ctx.reason).toBe('Over credit limit by $19,594.94');
    expect(ctx.facts).toEqual([
      'This order £85,000.00 ($107,594.94)',
      'Limit $100,000.00',
      'Balance $12,000.00',
    ]);
  });

  it('keeps one currency when the order is in the base currency', () => {
    const ctx = approvalContext(state('USD', 90_000, 1), 'ok');
    expect(ctx.reason).toBe('Over credit limit by $2,000.00');
    expect(ctx.facts[0]).toBe('This order $90,000.00');
  });
});
