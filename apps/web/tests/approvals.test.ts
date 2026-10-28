import { EMPTY_ORDER_STATE, type OrderState } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalContext,
  approvalContext,
  batchProgress,
  byUrgency,
  cannotSelect,
  deadlineWords,
  groupApprovals,
  groupName,
  lockAt,
  rowContext,
} from '../app/lib/approvals';

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
    // The rule leaves this order's figures out, so orders over the same limit group together.
    expect(ctx.rule).toBe('Over credit limit');
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
    expect(timedOut.rule).toBe('Over the $5,000.00 threshold');
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
    expect(ctx.rule).toBe('Over the $5,000.00 budget');
    expect(ctx.facts).toEqual(['This order $9,760.00', 'Budget $5,000.00']);
  });
});

describe('rowContext', () => {
  const record = {
    orderId: 'ord_01jxabc123',
    nodeId: 'mgr',
    title: 'Approve purchase ord_01jxabc123 (it)',
    stepLabel: 'Manager approval',
  };

  it('falls back to the approval’s own record when the order has no live state', () => {
    for (const state of [null, undefined]) {
      const ctx = rowContext(state, record);
      // The title's order id becomes the ref the row shows beside it.
      expect(ctx.reason).toBe('Approve purchase #abc123 (it)');
      expect(ctx.step).toBe('Manager approval');
      expect(ctx.deadline).toBeUndefined();
    }
  });

  it('keeps the live reason, figures and clock, and uses the record only for what is missing', () => {
    const s = purchase({ branch: 'approved' });
    s.waits = [
      { nodeId: 'mgr', eventType: 'e', kind: 'approval', title: 't', deadline: 5000, since: 0 },
    ];
    const live = rowContext(s, { ...record, stepLabel: 'Stale label' });
    expect(live.reason).toBe('Over the $5,000.00 threshold');
    expect(live.step).toBe('Manager approval');
    expect(live.deadline).toBe(5000);

    // Live state with no step that explains the request: the title says what it is.
    s.nodes.needs_mgr = { status: 'pending', runs: 0 };
    expect(rowContext(s, record).reason).toBe('Approve purchase #abc123 (it)');
  });

  it('leaves the reason empty rather than blank when there is no title', () => {
    expect(rowContext(null, { ...record, title: '' }).reason).toBeUndefined();
  });
});

describe('byUrgency', () => {
  it('puts the soonest escalation first, then the longest wait, and orders with no run last', () => {
    const row = (id: string, requestedAt: number) => ({ id, orderId: `ord_${id}`, requestedAt });
    const rows = [row('late', 10), row('norun', 1), row('soon', 30), row('old', 5), row('new', 40)];
    const ctx = (deadline?: number) => ({ facts: [], trail: [], deadline });
    const sorted = byUrgency(
      rows,
      { late: ctx(900), soon: ctx(100), norun: ctx(), old: ctx(), new: ctx() },
      { ord_norun: true },
    );
    expect(sorted.map((r) => r.id)).toEqual(['soon', 'late', 'old', 'new', 'norun']);
  });
});

describe('groupApprovals', () => {
  const ctx = (rule?: string, deadline?: number): ApprovalContext => ({
    facts: [],
    trail: [],
    rule,
    reason: rule,
    deadline,
    step: 'Finance approval',
  });
  const row = (
    id: string,
    over: Partial<{ nodeId: string; flowId: string; orderTitle: string }>,
  ) => ({
    id,
    nodeId: 'fin',
    flowId: 'tpl-purchase-request',
    flowName: 'Purchase request',
    orderTitle: 'Laptops for the new support team',
    ...over,
  });

  it('puts identical requests in one group, named by step, flow and rule, with the soonest deadline', () => {
    const rule = 'Over the $5,000.00 threshold';
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => row(id, {}));
    const context = Object.fromEntries(rows.map((r, i) => [r.id, ctx(rule, 9000 - i * 1000)]));
    const groups = groupApprovals(rows, context);
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(groupName(g!)).toBe(
      'Finance approval · Purchase request · Over the $5,000.00 threshold',
    );
    expect(g!.ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(g!.soonest).toBe(4000);
    // Every row is for the same thing, so the group says it once and the rows needn't.
    expect(g!.title).toBe('Laptops for the new support team');
  });

  it('never mixes flows, steps or rules, and keeps the order of each group’s most urgent row', () => {
    const rows = [
      row('credit', { nodeId: 'mgr' }),
      row('fin1', {}),
      row('other', { flowId: 'tpl-b2b-order' }),
      row('fin2', { orderTitle: 'Desks' }),
      row('budget', {}),
    ];
    const groups = groupApprovals(rows, {
      credit: ctx('Over the $5,000.00 threshold'),
      fin1: ctx('Over the $5,000.00 threshold'),
      other: ctx('Over the $5,000.00 threshold'),
      fin2: ctx('Over the $5,000.00 threshold'),
      budget: ctx('Over the $9,000.00 budget'),
    });
    expect(groups.map((g) => g.ids)).toEqual([['credit'], ['fin1', 'fin2'], ['other'], ['budget']]);
    // Titles differ, so each row keeps its own.
    expect(groups[1]!.title).toBeUndefined();
    // A lone row has nothing to share.
    expect(groups[0]!.title).toBeUndefined();
  });

  it('groups rows whose rule can’t be read by flow and step alone, apart from those whose can', () => {
    const groups = groupApprovals([row('a', {}), row('b', {}), row('c', {})], {
      a: ctx(),
      b: undefined,
      c: ctx('Over credit limit'),
    });
    expect(groups.map((g) => g.ids)).toEqual([['a', 'b'], ['c']]);
    expect(groupName(groups[0]!)).toBe('Finance approval · Purchase request');
  });
});

describe('cannotSelect', () => {
  const can = { canApprove: true };

  it('lets an open row its person can decide join a batch', () => {
    expect(cannotSelect(can)).toBeNull();
  });

  it('keeps every refusal a row’s own buttons keep', () => {
    expect(cannotSelect({ canApprove: false })).toMatch(/approver role/);
    expect(cannotSelect({ ...can, noRun: true })).toMatch(/No live run/);
    const own = 'You started this order, so someone else must decide its approvals.';
    expect(cannotSelect({ ...can, refused: own })).toBe(own);
    expect(cannotSelect({ ...can, closed: true })).toMatch(/closed/);
    // Held in its undo window, or sent: it can't be decided twice.
    expect(cannotSelect({ ...can, decided: true })).toMatch(/Already decided/);
  });
});

describe('batchProgress', () => {
  const held = { held: true, sent: false };
  const undone = { held: false, sent: false };
  const sent = (ok: boolean, error?: string) => ({
    held: false,
    sent: true,
    result: { ok, error },
  });

  it('holds while any decision is in its undo window, and each row can be taken back alone', () => {
    // Three approved together; the person undoes the second on its own row.
    expect(batchProgress('approved', [held, undone, held])).toMatchObject({
      phase: 'holding',
      held: 2,
    });
    // The other two run out their windows and are sent; one is still being recorded.
    expect(
      batchProgress('approved', [sent(true), undone, { held: false, sent: true }]),
    ).toMatchObject({ phase: 'sending' });
    expect(batchProgress('approved', [sent(true), undone, sent(true)])).toEqual({
      phase: 'done',
      held: 0,
      message: 'Approved 2. 1 taken back.',
    });
  });

  it('says when Undo all took everything back, and nothing was sent', () => {
    expect(batchProgress('rejected', [undone, undone]).message).toBe(
      'Took back 2; nothing was sent.',
    );
  });

  it('says what the order refused, row by row', () => {
    expect(
      batchProgress('rejected', [sent(true), sent(false, 'That node is not waiting')]).message,
    ).toBe('Rejected 1. 1 not recorded: That node is not waiting.');
    expect(batchProgress('approved', [sent(false, 'a'), sent(false, 'b')]).message).toBe(
      '2 not recorded; each row says why.',
    );
  });
});

describe('deadlineWords', () => {
  const now = Date.UTC(2026, 9, 27, 13, 0);
  // Deadlines are the step's; the words count to when decisions close, two seconds before.
  const at = (ms: number) => now + ms + (now - lockAt(now));

  it('counts down within the hour, warns in the last ten seconds, then says closed', () => {
    expect(deadlineWords(at(3 * 60_000), now)).toEqual({ kind: 'in', when: 'in 3m' });
    expect(deadlineWords(at(8_000), now)).toEqual({ kind: 'soon', when: 'in 8s' });
    expect(deadlineWords(at(0), now)).toEqual({ kind: 'closed' });
  });

  it('gives a later deadline as the time it closes, with the day when it isn’t today', () => {
    expect(deadlineWords(at(65 * 60_000), now, 'UTC')).toEqual({ kind: 'at', when: '2:05 PM UTC' });
    expect(deadlineWords(at(25 * 3_600_000), now, 'UTC')).toEqual({
      kind: 'at',
      when: 'Wed 2:00 PM UTC',
    });
  });
});
