import { readFileSync } from 'node:fs';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Code } from '../app/components/code';
import { loadHighlighter } from '../app/lib/highlighter';

const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');

/** The colour of each token in highlighted lines, by its text. */
const colours = (lines: ReactNode[][]) =>
  lines.flat().flatMap((n) => {
    if (!isValidElement(n)) return [];
    const { style, children } = (n as ReactElement<{ style: { color?: string }; children: string }>)
      .props;
    return [[children, style.color] as const];
  });

describe('the code block highlighter', () => {
  it('colours JSON and JavaScript with Ledger’s variables, each defined in app.css', async () => {
    const json = colours(
      (await loadHighlighter('json'))('{\n  "sku": "DESK-1",\n  "qty": 2,\n  "ok": true\n}').lines,
    );
    const js = colours(
      (await loadHighlighter('javascript'))(
        '// a rule\nexport const rules = { total: (o) => o.qty * 2, name: "x" };',
      ).lines,
    );
    const used = new Set(
      [...json, ...js].flatMap(([, c]) => (c ? [...c.matchAll(/var\((--shiki-[\w-]+)\)/g)] : [])),
    );
    expect(used.size).toBeGreaterThan(2);
    for (const [, name] of used) expect(css).toContain(`${name}:`);
    expect(js.find(([t]) => t === 'const')?.[1]).toContain('--shiki-token-keyword');
    expect(js.find(([t]) => t.includes('a rule'))?.[1]).toContain('--shiki-token-comment');
  });

  it('carries the grammar on from one call to the next', async () => {
    const highlight = await loadHighlighter('javascript');
    const first = highlight('/* a comment');
    const next = colours(highlight('still the comment */', first.state).lines);
    expect(next[0]?.[1]).toContain('--shiki-token-comment');
  });
});

describe('Code', () => {
  it('is the plain lines with a copy button until the colour loads', () => {
    const out = renderToStaticMarkup(
      createElement(Code, { value: '{\n  "a": 1\n}\n', language: 'json' }),
    );
    expect(out.match(/data-slot="code-block-line"/g)).toHaveLength(3);
    expect(out).toContain('aria-label="Copy"');
    expect(out).toContain('tabindex="0"');
  });
});
