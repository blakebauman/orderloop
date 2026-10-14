import { orderInputSchema, TEMPLATES, validateGraph } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { ago, dateTime, duration, money, statusColor, waitLabel } from '../app/lib/format';
import { SCENARIOS } from '../app/lib/scenarios';

const templates = Object.values(TEMPLATES).map((t) => t());

describe('demo scenarios', () => {
  for (const s of SCENARIOS) {
    it(`${s.id} targets a valid seeded flow of its order type`, () => {
      const flow = templates.find((t) => t.id === s.flowId);
      expect(flow, `no template ${s.flowId}`).toBeDefined();
      expect(flow!.model).toBe(s.input.model);
      expect(validateGraph(flow!).errors).toEqual([]);
      expect(orderInputSchema.safeParse(s.input).success).toBe(true);
    });
  }
});

describe('format', () => {
  it('names a wait without engine ids, or a customer that interpolated to nothing', () => {
    expect(waitLabel('Approve B2B order ord_mv6r5qrzvb6sbz for cus_contoso')).toBe(
      'Approve B2B order',
    );
    // Flows published before the B2B template dropped the customer, for an unknown sender.
    expect(waitLabel('Approve B2B order ord_mv6r5qrzvb6sbz for ')).toBe('Approve B2B order');
    expect(waitLabel('Approve B2B order ord_mv6r5qrzvb6sbz')).toBe('Approve B2B order');
    expect(waitLabel('Waiting for payment.received · Approve B2B order ord_x1 for ')).toBe(
      'payment.received · Approve B2B order',
    );
  });

  it('formats money and relative time', () => {
    expect(money(1163.69)).toBe('$1,163.69');
    expect(ago(Date.now() - 90_000)).toBe('2m ago');
    expect(ago(null)).toBe('—');
  });

  it('formats date-times in a pinned zone for SSR and labels UTC', () => {
    const t = Date.UTC(2026, 9, 13, 4, 46);
    expect(dateTime(t, 'UTC')).toBe('Oct 13, 2026, 4:46 AM UTC');
    expect(dateTime(t, 'America/Los_Angeles')).toBe('Oct 12, 2026, 9:46 PM');
  });

  it('maps statuses to theme tokens', () => {
    expect(statusColor('waiting')).toBe('var(--wait)');
    expect(statusColor('nonsense')).toBe('var(--idle)');
  });
});

describe('duration', () => {
  it('picks a unit that keeps the figure short', () => {
    expect(
      [12, 1_400, 45_000, 180_000, 9_000_000, 7_200_000 * 3, 4 * 86_400_000].map(duration),
    ).toEqual(['12ms', '1s', '45s', '3m', '2.5h', '6h', '4d']);
  });
});
