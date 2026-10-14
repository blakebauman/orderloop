import { describe, expect, it } from 'vitest';
import { nextPath } from '../app/lib/next-path';

const at = (next: string) =>
  nextPath(new Request(`https://orderloop.app/login?next=${encodeURIComponent(next)}`));

describe('nextPath', () => {
  it('keeps a path on this site', () => {
    expect(at('/orders/ord_1?tab=timeline')).toBe('/orders/ord_1?tab=timeline');
  });

  it('refuses anything a browser would send elsewhere', () => {
    for (const next of [
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'orders',
    ])
      expect(at(next)).toBe('/');
  });
});
