import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/env.server', () => ({ db: () => null }));

const { fillDays, totals, windowStart } = await import('../app/lib/metrics.server');
const { toRange } = await import('../app/lib/ranges');
const { Trends } = await import('../app/components/trends');

const NOW = Date.UTC(2026, 9, 24, 15, 0);
const EMPTY = { revenue: 0, collected: 0, refunded: 0, completed: 0, stopped: 0, failed: 0 };

describe('fillDays', () => {
  it('gives one row per UTC day, oldest first, ending today, with gaps empty', () => {
    const rows = new Map([
      ['2026-10-24', { revenue: 120 }],
      ['2026-10-20', { completed: 2, failed: 1 }],
      ['2026-07-01', { revenue: 999 }], // before the window
    ]);
    const days = fillDays(rows, 90, EMPTY, NOW);
    expect(days).toHaveLength(90);
    expect(days[0]?.day).toBe('2026-07-27');
    expect(days.at(-1)).toEqual({ ...EMPTY, revenue: 120, day: '2026-10-24' });
    expect(days.at(-5)).toEqual({ ...EMPTY, completed: 2, failed: 1, day: '2026-10-20' });
    expect(days.at(-2)).toEqual({ ...EMPTY, day: '2026-10-23' });
    expect(days.reduce((a, d) => a + d.revenue, 0)).toBe(120);
  });
});

describe('windowStart', () => {
  it('starts at midnight UTC on the first day the series shows', () => {
    for (const n of [7, 30, 90]) {
      const first = fillDays(new Map(), n, EMPTY, NOW)[0]?.day;
      expect(new Date(windowStart(n, NOW)).toISOString()).toBe(`${first}T00:00:00.000Z`);
    }
  });
});

describe('totals', () => {
  it('sums the series, so a total and its chart agree', () => {
    const daily = fillDays(
      new Map([
        ['2026-10-24', { revenue: 100, completed: 2, refunded: 5 }],
        ['2026-10-22', { revenue: 20, failed: 1, collected: 40 }],
      ]),
      7,
      EMPTY,
      NOW,
    );
    expect(totals(daily)).toEqual({
      revenue: 120,
      collected: 40,
      refunded: 5,
      completed: 2,
      stopped: 0,
      failed: 1,
    });
  });
});

describe('toRange', () => {
  it('accepts the offered ranges and falls back to 30 days', () => {
    expect(toRange('7')).toBe(7);
    expect(toRange('90')).toBe(90);
    expect(toRange('14')).toBe(30);
    expect(toRange(null)).toBe(30);
  });
});

describe('Trends', () => {
  it('server-renders the window figures and says when a chart has nothing to show', () => {
    const daily = fillDays(
      new Map([['2026-10-24', { revenue: 120, collected: 150, completed: 3 }]]),
      30,
      EMPTY,
      NOW,
    );
    const html = renderToString(createElement(Trends, { daily, totals: totals(daily), days: 30 }));
    expect(html).toContain('3 orders ended in the last 30 days: 3 completed');
    expect(html).not.toContain('No revenue');
    const empty = fillDays(new Map(), 7, EMPTY, NOW);
    const quiet = renderToString(
      createElement(Trends, { daily: empty, totals: totals(empty), days: 7 }),
    );
    expect(quiet).toContain('No revenue in the last 7 days.');
    expect(quiet).toContain('No payments in the last 7 days.');
  });
});
