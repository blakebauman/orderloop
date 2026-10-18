import { TEMPLATES } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { addOne, parseLines, summarizeFlow } from '../app/lib/new-order';

describe('parseLines', () => {
  it('reads each spelling of a line, and no number as one', () => {
    expect(parseLines('WID-100 x 50\n40 x gsk-010\n8 WID-200\nMON-27, 2\nTEE-01').lines).toEqual([
      { sku: 'WID-100', qty: 50 },
      { sku: 'GSK-010', qty: 40 },
      { sku: 'WID-200', qty: 8 },
      { sku: 'MON-27', qty: 2 },
      { sku: 'TEE-01', qty: 1 },
    ]);
  });

  it('refuses to guess: no SKU, zero or negative, or two numbers', () => {
    const { lines, issues } = parseLines(
      'widgets please\nWID-100 x 0\nWID-100 x -5\n2 x WID-100 for 3 stores\nWID-100 x 1.5',
    );
    expect(lines).toEqual([{ sku: 'WID-100', qty: 1.5 }]);
    expect(issues.map((i) => i.problem)).toEqual([
      'no SKU',
      'quantity must be above zero',
      'quantity must be above zero',
      'more than one number',
    ]);
  });

  it('checks SKUs against the catalog when given one', () => {
    const { issues } = parseLines('WID-100 x 2\nZZZ-999 x 1', new Set(['WID-100']));
    expect(issues).toEqual([{ line: 'ZZZ-999 x 1', problem: 'ZZZ-999 is not in the catalog' }]);
  });
});

describe('addOne', () => {
  it('adds a row, or one more to the row that already has the SKU', () => {
    expect(addOne('', 'WID-100')).toBe('WID-100 x 1');
    expect(addOne('WID-100 x 1\n', 'GSK-010')).toBe('WID-100 x 1\nGSK-010 x 1');
    expect(addOne('WID-100 x 4\nGSK-010 x 1', 'WID-100')).toBe('WID-100 x 5\nGSK-010 x 1');
  });
});

describe('summarizeFlow', () => {
  it('names where the B2B template asks a person and what it can undo', () => {
    const s = summarizeFlow(TEMPLATES['tpl-b2b-order']());
    expect(s.approvals.length).toBeGreaterThan(0);
    expect(s.rollbacks.length).toBeGreaterThan(0);
    expect(s.readsDocument).toBe(true);
    expect(s.routesFulfillment).toBe(false);
  });

  it('knows the omnichannel template routes fulfillment', () => {
    expect(summarizeFlow(TEMPLATES['tpl-omnichannel-order']()).routesFulfillment).toBe(true);
  });
});
