import { describe, expect, it } from 'vitest';
import { nextPath, withNext } from '../app/lib/next-path';

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

describe('withNext', () => {
  it('carries a path other than the home page', () => {
    expect(withNext('/login', '/orders/ord_1?tab=timeline')).toBe(
      '/login?next=%2Forders%2Ford_1%3Ftab%3Dtimeline',
    );
  });

  it('leaves off the home page, where sign-in goes anyway', () => {
    expect(withNext('/login', '/')).toBe('/login');
  });
});
