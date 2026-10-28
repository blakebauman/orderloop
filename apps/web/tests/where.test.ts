import { describe, expect, it } from 'vitest';
import { isOverdue, stoppedSteps, waitingOn, waitTrails } from '../app/lib/where';

const FLOWS = [
  { id: 'b2b', name: 'B2B order', steps: ['Credit check', 'Sales approval', 'Ship', 'Invoice'] },
  { id: 'web', name: 'Web order', steps: ['Charge', 'Fulfil'] },
];

describe('isOverdue', () => {
  it('is overdue only once the deadline has passed, and never without one', () => {
    expect(isOverdue(1_000, 999)).toBe(false);
    expect(isOverdue(1_000, 1_000)).toBe(true);
    expect(isOverdue(1_000, 5_000)).toBe(true);
    // A timer has no deadline: however long it has run, it is on time.
    expect(isOverdue(null, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isOverdue(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('waitingOn', () => {
  it('names a person by role (or as an approver), an outside event or a timer', () => {
    expect(waitingOn(null)).toBeNull();
    expect(waitingOn('person:sales_ops')).toBe('Sales ops');
    expect(waitingOn('person:ap')).toBe('Accounts payable');
    expect(waitingOn('person:trust_safety')).toBe('Trust and safety');
    expect(waitingOn('person:')).toBe('an approver');
    expect(waitingOn('event:carrier.delivered')).toBe('an outside event');
    expect(waitingOn('timer · event:x · event:y')).toBe('a timer or an outside event');
  });
});

describe('waitTrails', () => {
  it('lays waits along each flow in step order, busiest flow first, merging a step', () => {
    const trails = waitTrails(
      [
        { flowId: 'web', at: 'Fulfil', for: 'event:shipped', n: 1, oldest: 50, overdue: 0 },
        { flowId: 'b2b', at: 'Ship', for: 'timer', n: 2, oldest: 30, overdue: 0 },
        {
          flowId: 'b2b',
          at: 'Sales approval',
          for: 'person:finance',
          n: 1,
          oldest: 20,
          overdue: 1,
        },
        { flowId: 'b2b', at: 'Sales approval', for: 'person:', n: 2, oldest: 10, overdue: 1 },
      ],
      FLOWS,
    );
    expect(trails.map((t) => [t.name, t.open])).toEqual([
      ['B2B order', 5],
      ['Web order', 1],
    ]);
    expect(trails[0]?.steps).toEqual([
      { step: 'Sales approval', n: 3, oldest: 10, overdue: 2, on: 'Finance or an approver' },
      { step: 'Ship', n: 2, oldest: 30, overdue: 0, on: 'a timer' },
    ]);
  });

  it('keeps a flow or step it cannot place, last in its flow', () => {
    const [trail] = waitTrails(
      [
        { flowId: 'gone', at: null, for: null, n: 1, oldest: null, overdue: 0 },
        { flowId: 'gone', at: 'Pack', for: null, n: 1, oldest: 5, overdue: 0 },
      ],
      FLOWS,
    );
    expect(trail?.name).toBe('gone');
    expect(trail?.steps.map((s) => s.step)).toEqual(['An unnamed step', 'Pack']);
  });
});

describe('stoppedSteps', () => {
  it('ranks bad endings by count, then by the latest', () => {
    const rows = stoppedSteps(
      [
        { flowId: 'b2b', at: null, n: 1, rolledBack: 0, latest: 7, reason: null },
        { flowId: 'b2b', at: 'Ship', n: 1, rolledBack: 1, latest: 9, reason: 'carrier down' },
        { flowId: 'b2b', at: 'Credit check', n: 4, rolledBack: 0, latest: 3, reason: 'limit' },
      ],
      FLOWS,
    );
    expect(rows.map((r) => [r.step, r.name, r.n])).toEqual([
      ['Credit check', 'B2B order', 4],
      ['Ship', 'B2B order', 1],
      ['Before any step', 'B2B order', 1],
    ]);
  });
});
