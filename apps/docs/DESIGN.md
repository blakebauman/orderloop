---
name: Order Loop docs
description: The bound ledger's reading copy. The web app's Ledger system, read rather than operated.
colors:
  paper: "oklch(0.972 0.01 85)"
  paper-dark: "oklch(0.2 0.016 264)"
  ink: "oklch(0.25 0.022 262)"
  ink-dark: "oklch(0.92 0.014 85)"
  card: "oklch(0.993 0.004 85)"
  card-dark: "oklch(0.232 0.018 264)"
  muted: "oklch(0.94 0.011 85)"
  muted-dark: "oklch(0.262 0.018 264)"
  muted-foreground: "oklch(0.46 0.016 70)"
  muted-foreground-dark: "oklch(0.72 0.014 80)"
  rule: "oklch(0.86 0.014 80)"
  rule-dark: "oklch(0.33 0.018 264)"
  link: "oklch(0.47 0.13 256)"
  link-dark: "oklch(0.76 0.11 250)"
  ok: "oklch(0.455 0.105 152)"
  ok-dark: "oklch(0.77 0.1 152)"
  wait: "oklch(0.49 0.115 62)"
  wait-dark: "oklch(0.8 0.12 75)"
  bad: "oklch(0.5 0.185 28)"
  bad-dark: "oklch(0.71 0.16 28)"
  undo: "oklch(0.485 0.135 42)"
  undo-dark: "oklch(0.76 0.13 50)"
  ai: "oklch(0.49 0.16 310)"
  ai-dark: "oklch(0.75 0.09 305)"
  cat-commerce: "oklch(0.45 0.07 230)"
  cat-control: "oklch(0.5 0.1 62)"
  sheet: "oklch(0.985 0.006 85)"
  sheet-grid: "oklch(0.87 0.012 80)"
  node: "oklch(0.998 0.002 85)"
  node-border: "oklch(0.8 0.016 75)"
typography:
  display:
    fontFamily: "'IBM Plex Serif', ui-serif, Georgia, serif"
    fontSize: "clamp(2.125rem, 1.4rem + 3vw, 3.5rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.015em"
  page-title:
    fontFamily: "'IBM Plex Serif', ui-serif, Georgia, serif"
    fontSize: "clamp(1.875rem, 1.35rem + 1.6vw, 2.375rem)"
    fontWeight: 600
    lineHeight: 1.15
  section:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
  body:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.7
  lede:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
  code:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
  wordmark:
    fontFamily: "'IBM Plex Serif', ui-serif, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 600
rounded:
  md: "0.375rem"
  stamp: "2px"
  code: "3px"
spacing:
  column: "48rem"
  home-column: "72rem"
  top-bar: "3rem"
  sheet-grid: "20px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "2.25rem"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "2.25rem"
  header-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "2rem"
  sidebar-current:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.md}"
  node-card:
    backgroundColor: "{colors.node}"
    rounded: "{rounded.md}"
  stamp:
    rounded: "{rounded.stamp}"
    typography: "{typography.caption}"
  inline-code:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.code}"
    typography: "{typography.code}"
---

# Design System: Order Loop docs

This file describes `apps/docs`: the Starlight site at docs.orderloop.io and the Scalar page at
`/api/`. The system itself is the web app's, "Ledger", authored in `apps/web/app/app.css`; this file
records what the docs do with it. It is **derived from the shipped code** (`src/styles/brand.css`,
`src/components/`, the generated `src/styles/theme.css`). When the code and this file disagree,
fix whichever is wrong and say which in the commit.

## Overview

**North star: the ledger's reading copy.** The app is a commerce back office kept like a bound
ledger: blue-black ink on warm paper, hairline rules, one registrar blue, signal colours that mean a
status and nothing else. The docs are the same book for the moments you're not at the desk:
setting it up, looking up a route or a node, learning why an order took the branch it took. So the
material is the app's, and the page shows the mechanism with real data: real node types, real step
keys, a real run.

Most of the chrome is Starlight's, recoloured and re-set from the app's tokens rather than redrawn.
What is Order Loop's own is small: the serif page header, ruled sections, the app's top-bar
button, its node cards, status stamps, and the run figure on the home page.

**Key characteristics**

- Warm paper and blue-black ink; light by default, "ink night" when the reader picks Dark or Match
  system. Never dark by category.
- IBM Plex: Serif for the page title, the hero and the wordmark only; Sans for everything else;
  Mono for code, ids and step keys. Self-hosted.
- Hue only from the status ramp and the node categories, and only where there is a status or a
  node type to show.
- One 48rem reading column; the home page widens to 72rem for the run figure.
- Flat: hairlines and tonal steps. The node card's 1px bottom rule is the only shadow, and it is
  the app's.

## Colors

The palette is the app's, value for value. `packages/design/src/tokens.ts` holds it as data
(`LIGHT`, `DARK_OVERRIDES`, `FONTS`), its test fails if it stops matching `apps/web/app/app.css`,
and `pnpm sync:theme` writes the docs theme from it. The values in the frontmatter above are the
tokens, not approximations.

- **Paper / ink** are the page and the strongest text. Starlight's grey ramp is filled from them:
  `--sl-color-black` is paper and `--sl-color-white` is ink in both schemes.
- **Body text** is ink mixed 88% into paper, so headings in full ink still lead.
- **Muted foreground** is secondary text: the page description, captions, table column labels, the
  table of contents, step keys.
- **Card** is the app's panel ground: link cards, node cards' surroundings, code blocks, the run
  figure. **Muted** is the tonal step: inline code, the sidebar's current page.
- **Rule** is every hairline. **Input** is the stronger line under table header rows.
- **Link** (registrar blue) is links, focus and selection. It is not a status colour here, and
  notes do not use it.

### The status ramp (the only hue)

`ok` succeeded, `run` running (the link blue), `wait` waiting, `bad` failed, `undo` rolled back or
declined, `idle` pending or skipped, `ai` AI work. In the docs they appear on status stamps, the run
figure's status rules and labels, callouts, and Scalar's method labels. Node categories (`trigger`
ink, `commerce` steel blue, `control` amber, `ai` violet) colour node icons and nothing else.

**Green is "succeeded" and nothing else.** No green accent, brand mark or button anywhere.

Starlight's hue slots are filled from the ramp (`--sl-color-green` is `ok`, `orange` is `wait`,
`red` is `bad`, `blue` is `link`, `purple` is `ai`) so any Starlight component that reaches for a
hue lands on a Ledger one.

## Typography

- **Display** (hero title): Plex Serif 600, `clamp(34px, …, 56px)`, 1.08, −0.015em, max 24ch.
- **Page title**: Plex Serif 600, `clamp(30px, …, 38px)`. The one serif on an ordinary page, as
  the app's `PageHeader` uses it.
- **Lede**: the page's `description` under its title, 17px muted, max 68ch.
- **Section (h2)**: Plex Sans 600, 22px, opening on a rule. h3 17px, h4 15px.
- **Body**: 16px, 1.7.
- **Caption**: 12px 500 muted. Table column labels, fact labels.
- **Code**: Plex Mono, 13px in blocks, 0.875em inline.
- **Wordmark**: Plex Serif 600, 16px, beside the mark, as in the app's top bar.

Sentence case everywhere. No uppercase labels, no letter-spaced eyebrows.

## Layout

Starlight's three columns with the content at **48rem**. Tables and code wider than the column
scroll inside their box. The home page (`:root[data-has-hero]`) widens to **72rem** for the run
figure and its card grid, while its prose stays at 48rem.

The top bar is **3rem**, the app's 48px, with a rule under it.

The run figure lays its cards in one column, two from a 34rem container, four from 58rem (container
queries, so it behaves the same wherever it's placed). It reads left to right, row by row.

## Elevation & Depth

Flat. Separation is a hairline; depth is a tonal step (muted against paper, card against paper,
sheet behind nodes). The node card's `0 1px 0 rule` underline is the app's own and the only shadow
the docs author. Starlight's own shadows (search, link cards, pagination) are removed.

## Shapes

- **6px** (`--ol-radius`, the app's `--radius`): buttons, inputs, cards, callouts, node cards, code
  blocks, the sidebar's current page.
- **3px**: inline code, focus rings.
- **2px**: status stamps and output handles.
- Borders are 1px. The node card's 3px status rule is the one thicker line, and it is the app's
  canvas convention, drawn inside the card.

## Components

### Top bar

The serif wordmark with the mark; search as an app input (card ground, hairline, 32px); then "API
explorer" as a muted text link and **Open the app** as the one ink button, the app's "New order"
slot; GitHub; the theme select. The links ride an override of `SocialIcons`, the one slot in
Starlight's header right group, so `Header` stays Starlight's. Below 50rem the right group hides
and the sidebar's "OpenAPI explorer" entry remains.

### Theme select

The app's three choices: **Light** (the default), **Dark**, **Match system**. Stored as Starlight's
`starlight-theme` (`light`, `dark` or `auto`) and applied before first paint
(`ThemeProvider.astro`); the explorer reads the same key.

### Page header

`PageTitle.astro`: the serif title and, under it, the page's `description` in muted text.
Starlight otherwise only puts the description in `<meta>`.

### Sidebar

Group labels 14px 600 ink; links 14px muted, ink on hover. The current page is a tonal step (muted
fill, ink, 600), not Starlight's inverted pill.

### Sections and tables

An h2 opens on a 1px rule with space above it, as the app's panels open on their header row. The
rule sits on Starlight's `.sl-heading-wrapper` so it spans the column; the first section on a page
skips it because the page header already has one. Tables follow `packages/ui` `table.tsx`: caption
column labels on no fill, a hairline under each row, a soft muted hover, tabular numbers.

### Callouts

1px border at 30% of the hue, a 5% flat tint into paper, 6px corners. Note is ink (neutral), tip
is `ok`, caution is `wait`, danger is `bad`. Never a thick coloured edge.

### Buttons

Starlight's `LinkButton`: primary is ink with paper text, secondary is card with a hairline,
minimal is a link. 36px, 14px 500, 6px corners.

### Status stamp

`status.tsx`'s `Stamp`: a dot and a sentence-case label in the status colour on an 11% tint, 2px
corners, 12px 500.

### Node card (`OrderRun.astro`, `NodeCatalog.astro`)

The app's `flow-node.tsx`, read-only. A 3px status rule on the left edge (pulsing while live,
unless reduced motion is set), the category icon in its category colour (lucide, pinned to the
app's `lucide-react` version), `undo · waits` tags, the status in words, the label in 13px 600 ink,
the step key in mono (`credit#1`), the node's summary under a dashed rule, and its output branches
right-aligned with the taken one in ink and a filled handle. In the node catalog the same entry
drops the status and becomes a palette card: icon, label, type, tags, outputs, fields.

### The run figure (`OrderRun.astro`, home)

The docs' signature: one real B2B order drawn as the canvas draws it, on the editor's dotted sheet
(dots 20px apart, 1.2px, `sheet-grid` on `sheet`). Twelve reached nodes, joined by ink edges; a
"Waiting on payment.received" stamp in the panel header; subtotal, tax and total with the app's
accounting double rule under the total; a caption saying where the run came from and how many
nodes it skipped. The data is `src/data/sample-run.json`, captured from the engine;
`apps/engine/tests/docs-sample-run.test.ts` fails when the engine would now run it differently.

### Code blocks

Expressive Code with GitHub light and dark-dimmed syntax on the card ground, a hairline frame,
6px corners, no shadow, Plex Mono at 13px.

### OpenAPI explorer (`src/pages/api.astro`)

Scalar under the app's top bar (48px, rule, serif wordmark with the mark), with its palette from
`scalarThemeCss()` in `@orderloop/design` and the docs' faces. Its own dark-mode toggle is hidden.

### Browser surfaces

Focus is a 2px registrar-blue outline offset 2px on every control; selection is the link at 24%;
the caret is link blue; scrollbars are thin, in the rule colour; link underlines sit 3px clear at
40% of the link colour, full on hover; list markers are muted.

## Do's and Don'ts

### Do

- **Do** take every colour from `theme.css` (`--sl-*` or `--ol-*`). New tokens start in
  `apps/web/app/app.css`, then `packages/design/src/tokens.ts`, then `pnpm sync:theme`.
- **Do** draw Order Loop concepts with the app's own components: stamps for status, node cards
  for nodes, real step keys and branch names.
- **Do** use real data in figures, with a test or a script that keeps it real.
- **Do** separate with 1px hairlines and tonal steps.
- **Do** keep the serif to the page title, the hero and the wordmark.

### Don't

- **Don't** hand-edit `src/styles/theme.css`; a hook blocks it and the design tests catch it.
- **Don't** use green for anything but "succeeded", or a status hue for decoration.
- **Don't** add shadows, gradients, glass, or coloured edges thicker than 1px. The node card's
  status rule is the one exception, and it is the app's.
- **Don't** add uppercase or letter-spaced labels, or an eyebrow above a heading.
- **Don't** borrow styling from other projects (felix-web, durablefibers, Supabase): Ledger is
  this product's own.
