import { describe, expect, it } from 'vitest';
import { keepTicks, NO_TICKS, tick, tickAll, ticked } from '../app/lib/cart-ticks';

const a = { id: 'li_1', sku: 'WID-100' };
const b = { id: 'li_2', sku: 'GSK-010' };

describe('cart ticks', () => {
  it('ticks lines by id and SKU, in the cart’s order', () => {
    const t = tick(tick(NO_TICKS, b, true), a, true);
    expect(ticked(t, [a, b])).toEqual([a, b]);
    expect(ticked(tick(t, a, false), [a, b])).toEqual([b]);
    expect(ticked(tickAll([a, b], true), [a, b])).toEqual([a, b]);
    expect(ticked(tickAll([a, b], false), [a, b])).toEqual([]);
  });

  it('never carries a tick to a line added after the ticked one was removed', () => {
    const t = tickAll([a, b], true);
    // The cart removes li_2, then gives the next line added the same id: either SKU.
    const removed = keepTicks(t, [a], true);
    expect(ticked(removed, [a])).toEqual([a]);
    expect(removed.gone).toBe(1);
    for (const added of [b, { id: 'li_2', sku: 'WID-200' }])
      expect(ticked(keepTicks(removed, [a, added], true), [a, added])).toEqual([a]);
    // A line replaced under the same id without being seen gone still doesn't match on its SKU.
    expect(ticked(t, [a, { id: 'li_2', sku: 'WID-200' }])).toEqual([a]);
  });

  it('counts what went until the person chooses again', () => {
    const lost = keepTicks(tickAll([a, b], true), [a], true);
    expect(lost.gone).toBe(1);
    expect(keepTicks(lost, [a], true)).toBe(lost);
    expect(tick(lost, a, false).gone).toBe(0);
    expect(tickAll([a], true).gone).toBe(0);
  });

  it('drops every tick once the cart can’t be edited (locked, ended, cleared)', () => {
    const t = tickAll([a, b], true);
    expect(keepTicks(t, [a, b], false)).toEqual(NO_TICKS);
    expect(ticked(keepTicks(keepTicks(t, [a, b], false), [a, b], true), [a, b])).toEqual([]);
    expect(ticked(keepTicks(t, [], true), [a, b])).toEqual([]);
    expect(keepTicks(NO_TICKS, [a], false)).toBe(NO_TICKS);
  });
});
