import { orderInputSchema, TEMPLATES, validateGraph } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { ago, money, statusColor } from '../app/lib/format';
import { SCENARIOS } from '../app/lib/scenarios';

const templates = Object.values(TEMPLATES).map((t) => t());

describe('demo scenarios', () => {
  for (const s of SCENARIOS) {
    it(`${s.id} targets a valid seeded flow of its order type`, () => {
      const flow = templates.find((t) => t.id === s.flowId);
      expect(flow, `no template ${s.flowId}`).toBeDefined();
      expect(flow!.orderType).toBe(s.input.type);
      expect(validateGraph(flow!).errors).toEqual([]);
      expect(orderInputSchema.safeParse(s.input).success).toBe(true);
    });
  }
});

describe('format', () => {
  it('formats money and relative time', () => {
    expect(money(1163.69)).toBe('$1,163.69');
    expect(ago(Date.now() - 90_000)).toBe('2m ago');
    expect(ago(null)).toBe('—');
  });

  it('maps statuses to theme tokens', () => {
    expect(statusColor('waiting')).toBe('var(--wait)');
    expect(statusColor('nonsense')).toBe('var(--idle)');
  });
});
