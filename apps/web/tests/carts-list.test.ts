import { newId } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { cartOpens } from '../app/lib/carts';

describe('cartOpens', () => {
  it('opens every cart the engine makes', () => {
    for (let i = 0; i < 50; i++) expect(cartOpens(newId('cart'))).toBe(true);
  });

  it('offers no link for a row under an id the engine wouldn’t make', () => {
    expect(cartOpens('cart_bench_0001')).toBe(false);
    expect(cartOpens('cart_bench_zz')).toBe(false);
    expect(cartOpens('bench_cart_1')).toBe(false);
    expect(cartOpens('cart_')).toBe(false);
    expect(cartOpens('cart_ABC')).toBe(false);
    expect(cartOpens('ord_mh3k2abcdef')).toBe(false);
  });
});
