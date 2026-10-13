/**
 * Ledger, as data. The web app authors these values in apps/web/app/app.css (Tailwind v4 is
 * CSS-first, so that file stays the place a designer edits); this module is the same palette in a
 * form other surfaces can build from, and tests/tokens.test.ts fails when the two disagree. The docs
 * site's theme (apps/docs/src/styles/theme.css) and its OpenAPI explorer palette are generated from
 * it: change app.css, mirror the change here, then `pnpm sync:theme`.
 *
 * Pure constants and string builders, no imports: safe in Node, Vite and Workers alike.
 */

/**
 * Light: every custom property `:root` declares in app.css, value for value. A value may reference
 * another token with `var(--name)`, exactly as the app writes it.
 */
export const LIGHT = {
  radius: '0.375rem',
  paper: 'oklch(0.972 0.01 85)',
  background: 'var(--paper)',
  ink: 'oklch(0.25 0.022 262)',
  foreground: 'var(--ink)',
  card: 'oklch(0.993 0.004 85)',
  'card-foreground': 'var(--ink)',
  popover: 'oklch(0.993 0.004 85)',
  'popover-foreground': 'var(--ink)',
  primary: 'oklch(0.27 0.035 262)',
  'primary-foreground': 'oklch(0.975 0.008 85)',
  secondary: 'oklch(0.935 0.012 85)',
  'secondary-foreground': 'var(--ink)',
  muted: 'oklch(0.94 0.011 85)',
  'muted-foreground': 'oklch(0.46 0.016 70)',
  accent: 'oklch(0.93 0.013 85)',
  'accent-foreground': 'var(--ink)',
  destructive: 'oklch(0.5 0.185 28)',
  'destructive-foreground': 'oklch(0.985 0 0)',
  rule: 'oklch(0.86 0.014 80)',
  border: 'var(--rule)',
  input: 'oklch(0.8 0.016 80)',
  link: 'oklch(0.47 0.13 256)',
  ring: 'var(--link)',
  ok: 'oklch(0.455 0.105 152)',
  run: 'var(--link)',
  wait: 'oklch(0.49 0.115 62)',
  bad: 'oklch(0.5 0.185 28)',
  undo: 'oklch(0.485 0.135 42)',
  idle: 'oklch(0.48 0.012 75)',
  ai: 'oklch(0.49 0.16 310)',
  'cat-trigger': 'var(--ink)',
  'cat-commerce': 'oklch(0.45 0.07 230)',
  'cat-control': 'oklch(0.5 0.1 62)',
  'cat-ai': 'var(--ai)',
  sheet: 'oklch(0.985 0.006 85)',
  'sheet-grid': 'oklch(0.87 0.012 80)',
  node: 'oklch(0.998 0.002 85)',
  'node-border': 'oklch(0.8 0.016 75)',
  edge: 'oklch(0.62 0.015 70)',
  'edge-active': 'var(--ink)',
  'edge-idle': 'oklch(0.86 0.012 80)',
} as const;

export type Token = keyof typeof LIGHT;

/** Dark ("ink night"): the overrides `:root[data-theme="dark"]` declares in app.css. */
export const DARK_OVERRIDES: Partial<Record<Token, string>> = {
  paper: 'oklch(0.2 0.016 264)',
  ink: 'oklch(0.92 0.014 85)',
  card: 'oklch(0.232 0.018 264)',
  popover: 'oklch(0.25 0.018 264)',
  primary: 'oklch(0.92 0.014 85)',
  'primary-foreground': 'oklch(0.22 0.03 262)',
  secondary: 'oklch(0.28 0.018 264)',
  muted: 'oklch(0.262 0.018 264)',
  'muted-foreground': 'oklch(0.72 0.014 80)',
  accent: 'oklch(0.29 0.02 264)',
  destructive: 'oklch(0.68 0.17 28)',
  rule: 'oklch(0.33 0.018 264)',
  input: 'oklch(0.38 0.02 264)',
  link: 'oklch(0.76 0.11 250)',
  ok: 'oklch(0.77 0.1 152)',
  wait: 'oklch(0.8 0.12 75)',
  bad: 'oklch(0.71 0.16 28)',
  undo: 'oklch(0.76 0.13 50)',
  idle: 'oklch(0.67 0.012 75)',
  ai: 'oklch(0.75 0.09 305)',
  'cat-commerce': 'oklch(0.76 0.07 230)',
  'cat-control': 'oklch(0.8 0.11 75)',
  sheet: 'oklch(0.215 0.017 264)',
  'sheet-grid': 'oklch(0.31 0.018 264)',
  node: 'oklch(0.25 0.018 264)',
  'node-border': 'oklch(0.39 0.02 264)',
  edge: 'oklch(0.56 0.014 75)',
  'edge-idle': 'oklch(0.33 0.018 264)',
};

/** The faces app.css's `@theme` sets. Serif is for page and order titles only. */
export const FONTS = {
  sans: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  serif: '"IBM Plex Serif", ui-serif, Georgia, serif',
} as const;

export type Scheme = 'light' | 'dark';

/** Every token for a scheme with `var(--x)` references resolved to literal values. */
export function palette(scheme: Scheme): Record<Token, string> {
  const raw: Record<string, string> = {
    ...LIGHT,
    ...(scheme === 'dark' ? DARK_OVERRIDES : {}),
  };
  const resolve = (v: string, depth = 0): string => {
    const m = /^var\(--([\w-]+)\)$/.exec(v);
    if (!m) return v;
    const next = raw[m[1]!];
    if (next === undefined || depth > 8) throw new Error(`Unresolved token ${v}`);
    return resolve(next, depth + 1);
  };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)])) as Record<
    Token,
    string
  >;
}

const mix = (a: string, pct: number, b: string) => `color-mix(in oklch, ${a} ${pct}%, ${b})`;

/** The status signals and node categories the docs' components draw with, as `--ol-*`. */
const SIGNALS: Token[] = [
  'ok',
  'run',
  'wait',
  'bad',
  'undo',
  'idle',
  'ai',
  'cat-trigger',
  'cat-commerce',
  'cat-control',
  'cat-ai',
  'card',
  'muted',
  'muted-foreground',
  'rule',
  'input',
  'link',
  'paper',
  'ink',
  'sheet',
  'sheet-grid',
  'node',
  'node-border',
  'edge',
  'edge-active',
  'edge-idle',
];

function starlightBlock(scheme: Scheme): string[] {
  const p = palette(scheme);
  const vars: [string, string][] = [
    // Starlight's grey ramp runs from the page (`black`) to the strongest text (`white`) in both
    // schemes, so "white" is ink here and "black" is paper.
    ['--sl-color-black', p.paper],
    ['--sl-color-white', p.ink],
    ['--sl-color-gray-1', p.ink],
    // Body text: ink a step softer, so headings in full ink still lead.
    ['--sl-color-gray-2', mix(p.ink, 88, p.paper)],
    ['--sl-color-gray-3', p['muted-foreground']],
    ['--sl-color-gray-4', mix(p['muted-foreground'], 70, p.paper)],
    ['--sl-color-gray-5', p.rule],
    ['--sl-color-gray-6', p.muted],
    ['--sl-color-gray-7', p.secondary],
    // Registrar blue: links, focus, the current page marker.
    ['--sl-color-accent', p.link],
    ['--sl-color-accent-high', mix(p.link, 72, p.ink)],
    ['--sl-color-accent-low', mix(p.link, 14, p.paper)],
    // Starlight's hue slots, used by asides and badges, on the status ramp.
    ['--sl-color-green', p.ok],
    ['--sl-color-green-high', p.ok],
    ['--sl-color-green-low', mix(p.ok, 11, p.paper)],
    ['--sl-color-orange', p.wait],
    ['--sl-color-orange-high', p.wait],
    ['--sl-color-orange-low', mix(p.wait, 11, p.paper)],
    ['--sl-color-red', p.bad],
    ['--sl-color-red-high', p.bad],
    ['--sl-color-red-low', mix(p.bad, 11, p.paper)],
    ['--sl-color-blue', p.link],
    ['--sl-color-blue-high', p.link],
    ['--sl-color-blue-low', mix(p.link, 11, p.paper)],
    ['--sl-color-purple', p.ai],
    ['--sl-color-purple-high', p.ai],
    ['--sl-color-purple-low', mix(p.ai, 11, p.paper)],
    ['--sl-color-text', 'var(--sl-color-gray-2)'],
    ['--sl-color-text-accent', p.link],
    ['--sl-color-text-invert', p.paper],
    ['--sl-color-bg', p.paper],
    // The app's top bar and its page share one ground, divided by a rule.
    ['--sl-color-bg-nav', p.paper],
    ['--sl-color-bg-sidebar', p.paper],
    ['--sl-color-bg-inline-code', p.muted],
    ['--sl-color-bg-accent', p.ink],
    ['--sl-color-hairline', p.rule],
    ['--sl-color-hairline-light', p.rule],
    ['--sl-color-hairline-shade', p.rule],
    ['--sl-color-backdrop-overlay', mix(p.ink, 40, 'transparent')],
    ...SIGNALS.map((t): [string, string] => [`--ol-${t}`, p[t]]),
  ];
  return vars.map(([k, v]) => `  ${k}: ${v};`);
}

/**
 * The docs' Starlight theme: Ledger mapped onto Starlight's colour slots, light by default, dark
 * under `data-theme="dark"`, plus the faces and the app's radius. Written to
 * apps/docs/src/styles/theme.css by `pnpm sync:theme`.
 */
export function starlightThemeCss(): string {
  return [
    '/* @generated by `pnpm sync:theme` from packages/design/src/tokens.ts. Do not edit. */',
    ':root,',
    ':root[data-theme="light"] {',
    ...starlightBlock('light'),
    '  color-scheme: light;',
    '}',
    ':root[data-theme="dark"] {',
    ...starlightBlock('dark'),
    '  color-scheme: dark;',
    '}',
    ':root {',
    `  --sl-font: ${FONTS.sans};`,
    `  --sl-font-mono: ${FONTS.mono};`,
    `  --ol-font-serif: ${FONTS.serif};`,
    `  --ol-radius: ${LIGHT.radius};`,
    '}',
    '',
  ].join('\n');
}

function scalarBlock(scheme: Scheme): string {
  const p = palette(scheme);
  return [
    `--scalar-background-1: ${p.paper};`,
    `--scalar-background-2: ${p.card};`,
    `--scalar-background-3: ${p.muted};`,
    `--scalar-background-accent: ${mix(p.link, 12, p.paper)};`,
    `--scalar-color-1: ${p.ink};`,
    `--scalar-color-2: ${mix(p.ink, 82, p.paper)};`,
    `--scalar-color-3: ${p['muted-foreground']};`,
    `--scalar-color-accent: ${p.link};`,
    `--scalar-border-color: ${p.rule};`,
    `--scalar-sidebar-background-1: ${p.paper};`,
    `--scalar-sidebar-item-active-background: ${p.muted};`,
    `--scalar-sidebar-color-active: ${p.ink};`,
    `--scalar-color-green: ${p.ok};`,
    `--scalar-color-blue: ${p.link};`,
    `--scalar-color-orange: ${p.wait};`,
    `--scalar-color-yellow: ${p.wait};`,
    `--scalar-color-red: ${p.bad};`,
    `--scalar-color-purple: ${p.ai};`,
    `--scalar-button-1: ${p.primary};`,
    `--scalar-button-1-color: ${p['primary-foreground']};`,
    `--scalar-button-1-hover: ${mix(p.primary, 90, p.paper)};`,
    `--scalar-radius: ${LIGHT.radius};`,
    `--scalar-radius-lg: calc(${LIGHT.radius} + 2px);`,
    `--scalar-font: ${FONTS.sans};`,
    `--scalar-font-code: ${FONTS.mono};`,
  ].join('\n    ');
}

/** The OpenAPI explorer's palette (Scalar's `customCss`), from the same tokens. */
export function scalarThemeCss(): string {
  return `
  .light-mode {
    ${scalarBlock('light')}
  }
  .dark-mode {
    ${scalarBlock('dark')}
  }`;
}
