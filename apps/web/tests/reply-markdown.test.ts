import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { describe, expect, it } from 'vitest';

// vitest.config.ts resolves Streamdown's `rehype-raw` to the no-op stub, as a build does.

const render = (text: string) =>
  renderToString(createElement(Streamdown, { mode: 'static', controls: false }, text));

describe('assistant replies without rehype-raw', () => {
  it('still render Markdown', () => {
    const html = render('A **bold** word and [a link](/orders/ord_1).\n\n- one\n- two');
    expect(html).toContain('data-streamdown="strong">bold<');
    expect(html).toContain('data-streamdown="unordered-list"');
    expect(html).toMatch(/>one<\/li>/);
    expect(html).toMatch(/data-streamdown="link"[^>]*>a link</);
  });

  // `<kbd>` passes Streamdown's sanitizer, so with rehype-raw it would render as an element.
  it('drop raw HTML instead of parsing it', () => {
    const html = render('Press <kbd>K</kbd> to search.');
    expect(html).not.toContain('<kbd');
    expect(html).toContain('Press');
    expect(html).toContain('to search.');
  });
});
