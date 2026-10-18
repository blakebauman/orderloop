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
    shipping: 0,
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

/** The purchase-request shape: a threshold sends the order to a manager, whose timeout goes to finance. */
const purchase = (mgr: { branch: string; by?: string }): OrderState => {
  const s = state('USD', 9760, 1);
  const node = (id: string, type: string, label: string, config = {}) => ({
    id,
    type,
    label,
    config,
    position: { x: 0, y: 0 },
  });
  return {
    ...s,
    order: {
      ...s.order!,
      lines: [
        { sku: 'LAP-14', qty: 8 },
        { sku: 'MON-27', qty: 8 },
      ],
    },
    flow: {
      ...s.flow!,
      nodes: [
        node('needs_mgr', 'control.condition', 'Over $5k?', {
          expression: { '>': [{ var: 'order.total' }, 5000] },
        }),
        node('mgr', 'control.approval', 'Manager approval'),
        node('fin', 'control.approval', 'Finance approval'),
        node('expire', 'commerce.notify', 'Tell requester'),
      ],
      edges: [
        { id: 'a', source: 'needs_mgr', target: 'mgr', sourceHandle: 'true', targetHandle: null },
        { id: 'b', source: 'mgr', target: 'fin', sourceHandle: 'escalated', targetHandle: null },
        { id: 'c', source: 'mgr', target: 'fin', sourceHandle: 'approved', targetHandle: null },
        { id: 'd', source: 'fin', target: 'expire', sourceHandle: 'escalated', targetHandle: null },
      ],
    },
    nodes: {
      needs_mgr: { status: 'succeeded', runs: 1, branches: ['true'], summary: 'true' },
      mgr: {
        status: 'succeeded',
        runs: 1,
        branches: [mgr.branch],
        output: { outcome: mgr.branch, ...(mgr.by ? { by: mgr.by } : {}) },
      },
    },
  };
};

describe('approvalContext reasons', () => {
  it('says a threshold in words, not the condition’s raw answer', () => {
    const ctx = approvalContext(purchase({ branch: 'approved' }), 'mgr');
    expect(ctx.reason).toBe('Over the $5,000.00 threshold');
    expect(ctx.facts).toEqual(['This order $9,760.00']);
    expect(ctx.lines).toBe('8 × LAP-14, 8 × MON-27');
    expect(ctx.trail).toEqual([]);
  });

  it('keeps the reason through an earlier approval, and lists that approval as history', () => {
    const timedOut = approvalContext(purchase({ branch: 'escalated' }), 'fin');
    expect(timedOut.reason).toBe('Over the $5,000.00 threshold');
    expect(timedOut.trail).toEqual(['Manager approval timed out']);
    expect(timedOut.onTimeout).toBe('Tell requester');
    const approved = approvalContext(purchase({ branch: 'approved', by: 'dana' }), 'fin');
    expect(approved.trail).toEqual(['Manager approval approved by dana']);
  });

  it('answers a question it can’t read as a threshold, and says budgets with figures', () => {
    const s = purchase({ branch: 'approved' });
    s.flow!.nodes[0]!.config = { expression: { '==': [{ var: 'vars.category' }, 'it'] } };
    expect(approvalContext(s, 'mgr').reason).toBe('Over $5k');

    s.flow!.nodes[0] = { ...s.flow!.nodes[0]!, type: 'commerce.budget_check', label: 'Budget' };
    s.flow!.edges[0] = { ...s.flow!.edges[0]!, sourceHandle: 'over' };
    s.nodes.needs_mgr = {
      status: 'succeeded',
      runs: 1,
      branches: ['over'],
      output: { budget: 5000 },
    };
    const ctx = approvalContext(s, 'mgr');
    expect(ctx.reason).toBe('Over the $5,000.00 budget by $4,760.00');
    expect(ctx.facts).toEqual(['This order $9,760.00', 'Budget $5,000.00']);
  });
});
