import { describe, expect, it } from 'vitest';
import { lanes } from '../app/lib/attention';

describe('lanes', () => {
  it('groups waits by who they are on, people first, oldest first', () => {
    const out = lanes([
      {
        at: 'Customer collects',
        on: 'Waiting for pickup.collected',
        for: 'event:pickup.collected',
        n: 2,
        oldest: 300,
      },
      { at: 'Sales approval', on: 'Approve B2B order', for: 'person:sales_ops', n: 1, oldest: 200 },
      { at: 'Until renewal', on: null, for: 'timer', n: 1, oldest: 100 },
      { at: 'Manager approval', on: 'Approve purchase', for: 'person:manager', n: 3, oldest: 50 },
    ]);
    expect(out.map((l) => [l.group, l.step, l.on, l.n])).toEqual([
      ['people', 'Manager approval', 'Manager', 3],
      ['people', 'Sales approval', 'Sales ops', 1],
      ['outside', 'Customer collects', 'Customer collects', 2],
      ['timers', 'Until renewal', 'a timer', 1],
    ]);
  });

  it('merges the same lane and keeps the oldest; falls back for rows indexed before waiting_for', () => {
    const out = lanes([
      {
        at: 'Payment received',
        on: 'Waiting for payment.received',
        for: 'event:payment.received',
        n: 1,
        oldest: 500,
      },
      {
        at: 'Payment received',
        on: 'Waiting for payment.received',
        for: 'event:payment.received',
        n: 2,
        oldest: 400,
      },
      { at: null, on: 'Waiting for return.requested', for: null, n: 1, oldest: null },
      { at: null, on: null, for: null, n: 1, oldest: null },
    ]);
    expect(out).toEqual([
      { group: 'outside', step: 'Payment received', on: 'Payment', n: 3, oldest: 400 },
      { group: 'outside', step: 'Return request', on: '', n: 1, oldest: null },
      { group: 'unknown', step: 'Step not recorded', on: '', n: 1, oldest: null },
    ]);
  });
});
