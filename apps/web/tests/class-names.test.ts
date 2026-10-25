import { cn } from '@orderloop/ui/lib/utils';
import { describe, expect, it } from 'vitest';

describe('cn', () => {
  it('keeps the theme’s text sizes beside a text color', () => {
    expect(cn('px-2.5 text-ui', 'text-muted-foreground')).toBe(
      'px-2.5 text-ui text-muted-foreground',
    );
    expect(cn('text-2xs', 'text-wait')).toBe('text-2xs text-wait');
  });

  it('lets a later size replace a theme size, and the reverse', () => {
    expect(cn('text-ui', 'text-sm')).toBe('text-sm');
    expect(cn('text-sm', 'text-2xs')).toBe('text-2xs');
  });
});
