/**
 * The lines ticked on a cart's page (`components/cart-view.tsx`), for its bulk Set quantity and
 * Remove. A cart reuses a removed line's id for the next line added (`applyLines`), so a tick is
 * held as the line's id and SKU and is dropped the moment the cart is seen without that line: a
 * line removed and added again, by anyone, comes back unticked. What was dropped is counted, so
 * Set quantity can refuse the person's choice as a whole instead of quietly setting the rest.
 */

import type { CheckoutLine } from '@orderloop/core';

export type CartTicks = {
  /** Line id to the SKU it had when ticked. */
  picked: ReadonlyMap<string, string>;
  /** Ticked lines the cart has lost since the person last changed their choice. */
  gone: number;
};

export const NO_TICKS: CartTicks = { picked: new Map(), gone: 0 };

type Line = Pick<CheckoutLine, 'id' | 'sku'>;

const holds = (lines: readonly Line[], id: string, sku: string) =>
  lines.some((l) => l.id === id && l.sku === sku);

/** The ticks as they stand against the cart now; none once it can't be edited. */
export function keepTicks(t: CartTicks, lines: readonly Line[], editable: boolean): CartTicks {
  if (!editable) return t.picked.size || t.gone ? NO_TICKS : t;
  const picked = new Map([...t.picked].filter(([id, sku]) => holds(lines, id, sku)));
  if (picked.size === t.picked.size) return t;
  return { picked, gone: t.gone + t.picked.size - picked.size };
}

/** Ticks or unticks one line. The person has chosen again, so nothing counts as gone. */
export function tick(t: CartTicks, line: Line, on: boolean): CartTicks {
  const picked = new Map(t.picked);
  if (on) picked.set(line.id, line.sku);
  else picked.delete(line.id);
  return { picked, gone: 0 };
}

/** Every line, or none. */
export const tickAll = (lines: readonly Line[], on: boolean): CartTicks => ({
  picked: new Map(on ? lines.map((l) => [l.id, l.sku]) : []),
  gone: 0,
});

/** The cart's lines that are ticked, in the cart's order. */
export const ticked = <L extends Line>(t: CartTicks, lines: readonly L[]): L[] =>
  lines.filter((l) => t.picked.get(l.id) === l.sku);
