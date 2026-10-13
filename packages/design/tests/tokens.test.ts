import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DARK_OVERRIDES, FONTS, LIGHT, palette, starlightThemeCss } from '../src/tokens';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const appCss = read('../../../apps/web/app/app.css');

/** The custom properties one rule block in app.css declares, in source order. */
function declarations(selector: string): Record<string, string> {
  const start = appCss.indexOf(selector);
  if (start < 0) throw new Error(`app.css has no ${selector} block`);
  const open = appCss.indexOf('{', start);
  const body = appCss.slice(open + 1, appCss.indexOf('}', open));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

describe('Ledger tokens match apps/web/app/app.css', () => {
  it('light: every `:root` token, value for value', () => {
    expect(LIGHT).toEqual(declarations(':root {'));
  });

  it('dark: every `:root[data-theme="dark"]` override, value for value', () => {
    expect(DARK_OVERRIDES).toEqual(declarations(':root[data-theme="dark"] {'));
  });

  it('faces: the `@theme` font stacks', () => {
    const theme = declarations('@theme {');
    expect({
      sans: theme['font-sans'],
      mono: theme['font-mono'],
      serif: theme['font-serif'],
    }).toEqual(FONTS);
  });

  it('resolves every reference in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const v of Object.values(palette(scheme))) expect(v).not.toMatch(/var\(/);
    }
  });
});

describe('generated docs theme', () => {
  it('apps/docs/src/styles/theme.css is current (run `pnpm sync:theme`)', () => {
    expect(read('../../../apps/docs/src/styles/theme.css')).toBe(starlightThemeCss());
  });
});
