import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Ago } from '../app/components/ago';

describe('Ago', () => {
  it('server-renders a machine-readable time with the UTC time as its tooltip', () => {
    const ms = Date.UTC(2026, 9, 13, 12, 0);
    const html = renderToString(createElement(Ago, { ms: Date.now() - 3 * 60_000 }));
    expect(html).toMatch(/^<time dateTime="[^"]+Z" title="[^"]+ UTC">3m ago<\/time>$/);
    const fixed = renderToString(createElement(Ago, { ms }));
    expect(fixed).toContain('dateTime="2026-10-13T12:00:00.000Z"');
    expect(fixed).toContain('title="Oct 13, 2026, 12:00 PM UTC"');
  });

  it('renders a dash without a time', () => {
    expect(renderToString(createElement(Ago, { ms: null }))).toBe('—');
  });
});
