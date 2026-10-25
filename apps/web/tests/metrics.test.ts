import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/env.server', () => ({ db: () => null }));

const { fillDays, SERIES_DAYS } = await import('../app/lib/metrics.server');
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
    const days = fillDays(rows, SERIES_DAYS, EMPTY, NOW);
    expect(days).toHaveLength(90);
    expect(days[0]?.day).toBe('2026-07-27');
    expect(days.at(-1)).toEqual({ ...EMPTY, revenue: 120, day: '2026-10-24' });
    expect(days.at(-5)).toEqual({ ...EMPTY, completed: 2, failed: 1, day: '2026-10-20' });
    expect(days.at(-2)).toEqual({ ...EMPTY, day: '2026-10-23' });
    expect(days.reduce((a, d) => a + d.revenue, 0)).toBe(120);
  });
});

describe('Trends', () => {
  it('server-renders the 30-day figures and says when a chart has nothing to show', () => {
    const daily = fillDays(
      new Map([['2026-10-24', { revenue: 120, collected: 150, completed: 3 }]]),
      SERIES_DAYS,
      EMPTY,
      NOW,
    );
    const html = renderToString(createElement(Trends, { daily }));
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>30 days</);
    expect(html).toContain('30 days');
    expect(html).toContain('3 orders ended in the last 30 days: 3 completed');
    expect(html).not.toContain('No revenue');
    const quiet = renderToString(
      createElement(Trends, { daily: fillDays(new Map(), 90, EMPTY, NOW) }),
    );
    expect(quiet).toContain('No revenue in the last 30 days.');
    expect(quiet).toContain('No payments in the last 30 days.');
  });
});
