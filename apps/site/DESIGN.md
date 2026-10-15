---
name: OrderLoop site
description: Bolder Ledger. The web app's Ledger system set at persuasion scale for orderloop.app.
colors:
  paper: "oklch(0.972 0.01 85)"
  paper-dark: "oklch(0.2 0.016 264)"
  ink: "oklch(0.25 0.022 262)"
  ink-dark: "oklch(0.92 0.014 85)"
  ink-soft: "color-mix(in oklch, oklch(0.25 0.022 262) 78%, oklch(0.972 0.01 85))"
  primary: "oklch(0.27 0.035 262)"
  primary-foreground: "oklch(0.975 0.008 85)"
  card: "oklch(0.993 0.004 85)"
  sheet: "oklch(0.985 0.006 85)"
  sheet-dark: "oklch(0.215 0.017 264)"
  sheet-grid: "oklch(0.87 0.012 80)"
  node: "oklch(0.998 0.002 85)"
  node-border: "oklch(0.8 0.016 75)"
  edge: "oklch(0.62 0.015 70)"
  rule: "oklch(0.86 0.014 80)"
  rule-dark: "oklch(0.33 0.018 264)"
  input: "oklch(0.8 0.016 80)"
  muted-foreground: "oklch(0.46 0.016 70)"
  muted-foreground-dark: "oklch(0.72 0.014 80)"
  link: "oklch(0.47 0.13 256)"
  link-dark: "oklch(0.76 0.11 250)"
  ok: "oklch(0.455 0.105 152)"
  wait: "oklch(0.49 0.115 62)"
  bad: "oklch(0.5 0.185 28)"
  undo: "oklch(0.485 0.135 42)"
  undo-dark: "oklch(0.76 0.13 50)"
  cat-commerce: "oklch(0.45 0.07 230)"
  cat-control: "oklch(0.5 0.1 62)"
typography:
  display:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.75rem, 1.2rem + 4.6vw, 5.5rem)"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.032em"
  headline:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.125rem, 1.2rem + 3vw, 4rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.032em"
  title:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.75rem, 1.1rem + 2vw, 2.75rem)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.028em"
  claim:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.25rem, 1rem + 0.9vw, 1.75rem)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  lede:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.0625rem, 0.95rem + 0.4vw, 1.25rem)"
    fontWeight: 400
    lineHeight: 1.6
  entry:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.0625rem, 0.95rem + 0.45vw, 1.3125rem)"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "'ss02'"
  small:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
  label:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.3
  code:
    fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.55
  wordmark:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    letterSpacing: "-0.015em"
rounded:
  md: "0.375rem"
  node: "5px"
  plate: "calc(0.375rem + 4px)"
  choice: "999px"
  focus: "3px"
spacing:
  gutter: "clamp(1rem, 0.4rem + 2.4vw, 2.5rem)"
  max: "84rem"
  top-bar: "3.5rem"
  section: "clamp(5rem, 10vw, 9rem)"
  spine: "clamp(10rem, 16vw, 13rem)"
  lane: "2rem"
  row: "1.75rem"
  sheet-grid: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 0.875rem"
    height: "2.25rem"
  button-primary-large:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 1.25rem"
    height: "3rem"
  button-secondary:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 1.25rem"
    height: "3rem"
  button-secondary-hover:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
  text-link:
    textColor: "{colors.link}"
  flow-plate:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.plate}"
    padding: "clamp(0.75rem, 1.5vw, 1.25rem)"
  plate-node:
    backgroundColor: "{colors.node}"
    textColor: "{colors.ink}"
    rounded: "{rounded.node}"
  spine-pill:
    backgroundColor: "{colors.node}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.node}"
    padding: "0.3rem 0.625rem 0.3rem 0.875rem"
  spine-pill-end:
    backgroundColor: "{colors.node}"
    textColor: "{colors.bad}"
    rounded: "{rounded.node}"
  spine-pill-undone:
    backgroundColor: "{colors.node}"
    textColor: "{colors.undo}"
    rounded: "{rounded.node}"
  ledger-entry-code:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
    padding: "0.875rem 1rem"
  reversal-stamp:
    textColor: "{colors.undo}"
    typography: "{typography.small}"
  outcome-choice:
    textColor: "{colors.ink}"
    rounded: "{rounded.choice}"
    padding: "0.125rem 0.75rem 0.2rem"
  outcome-choice-fails:
    backgroundColor: "{colors.bad}"
    textColor: "{colors.paper}"
    rounded: "{rounded.choice}"
  outcome-choice-succeeds:
    backgroundColor: "{colors.ok}"
    textColor: "{colors.paper}"
    rounded: "{rounded.choice}"
  lane-switch-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  ink-band:
    backgroundColor: "{colors.paper-dark}"
    textColor: "{colors.ink-dark}"
    padding: "clamp(4rem, 8vw, 7rem) 0"
---

# Design System: OrderLoop site

This file describes `apps/site`, the static page at orderloop.app. The system underneath is the web
app's, "Ledger", authored in `apps/web/app/app.css` and mirrored in `packages/design/src/tokens.ts`.
The site never copies those values: `src/layouts/Base.astro` writes every custom property from
`palette()` and `FONTS` in `@orderloop/design` at build time. This file records what the site adds
to Ledger, and it is **derived from the shipped code** (`src/styles/site.css`, `src/components/`,
`src/lib/flow.ts`, `src/lib/motion.ts`). When the code and this file disagree, the code is right
and this file gets fixed. The docs' reading copy of the same system is `apps/docs/DESIGN.md`.

## Overview

**Creative North Star: "Bolder Ledger"**

The app keeps orders like a bound ledger: blue-black ink on warm paper, hairline rules, one
registrar blue, signal colours that mean a status and nothing else. The site uses the same
material on a page that has to persuade, so it turns the scale up, not the volume. Display type
runs to 88px with tight tracking, section heads close on a 2px ink rule, and the one order the
page tells is drawn as the book itself: the flow set as ledger lines on the hero sheet, then one
order read as a double-entry page, operations on the left, engineering on the right, the flow
down the spine between them.

Everything that moves is the run. A token rides the hero flow once; a failed capture reverses
the ledger in order, newest entry first. Reduced motion and no script show the finished state,
complete.

**Key Characteristics:**

- Ledger's paper, ink, rules and status ramp, written from `@orderloop/design`; light by default,
  ink night on request.
- IBM Plex only, self-hosted: Sans 600 at display scale, Mono only for real step keys, JSON and
  HTTP.
- Ruled, not boxed: hairline rows, 2px ink rules under section heads, a double rule where an
  account closes.
- The flow is the illustration: real template data, levelled by the core planner.
- Reversals are ledger reversals: a rust strike plus a counter-entry on the same line.
- One inverted band for the deployment section, set in the other theme's palette.

## Colors

The palette is Ledger's, value for value. The frontmatter mirrors only the tokens this page uses,
for tools that need literals; the authority is `apps/web/app/app.css`, then
`packages/design/src/tokens.ts`. A changed token changes there, and this page picks it up on the
next build.

### Primary
- **Ledger Ink** (`primary`): the ink button, the active lane switch, the skip link. Within a hair
  of `ink` in light; in ink night it flips to the paper tone, so the button stays the strongest
  mark on either ground.
- **Registrar Blue** (`link`): text links, focus rings, selection (24%), the replay token riding
  the hero flow, and HTTP paths in the intake list. Live work and links only.

### Status ramp
- **Succeeded Green** (`ok`): the plate's outcome dot and the "succeeds" choice. Nothing else.
- **Waiting Amber** (`wait`): the waits mark on the plate, the legend's "waits" rule, the Return
  window pill's border, the one-beat pulse when the token reaches a wait.
- **Failed Red** (`bad`): the "fails" choice, the End node pill and its double rule, the outcome
  name in the operations lane.
- **Undo Rust** (`undo`): the rollback mark on the plate, every reversal (strike, stamp,
  counter-entry, struck pill, dashed spine).
- **Node categories** (`cat-commerce` steel blue, `cat-control` amber, `cat-trigger` ink): the
  12x2 tick on plate nodes and the 4px square on spine pills. They tag a node type and nothing
  else.

### Neutral
- **Warm Paper** (`paper`): the page ground, sticky lane heads and lane switch.
- **Blue-Black Ink** (`ink`): headings, ops-lane entries, edges and borders of the run.
- **Soft Ink** (`ink-soft`): the site's one derived colour, ink mixed 78% into paper. Ledes,
  section-head copy, the engineering lane, definition text. Declared on `:root` and again on the
  band, because a derived token resolves where it is declared.
- **Sheet / Sheet Grid** (`sheet`, `sheet-grid`): the hero plate's ground and its dot grid; the
  spine column's ground.
- **Node / Node Border / Edge** (`node`, `node-border`, `edge`): node fills, resting node outlines,
  ghost branches.
- **Card** (`card`): code entries in the ledger, secondary button hover.
- **Rule / Input** (`rule`, `input`): every hairline; the stronger line on outlined controls.
- **Muted Foreground** (`muted-foreground`): nav, captions, lane heads, table column labels, ghost
  node labels, struck code entries.

**The Status Means Status Rule.** Green succeeded, amber waits, red failed, rust undone. A status
hue appears only where that status is being shown; green is never a brand or button colour.

**The Written-From-Tokens Rule.** No colour value is typed in `site.css`. Every colour is a token
from `@orderloop/design` or a `color-mix` of tokens.

## Typography

**Display Font:** IBM Plex Sans (with ui-sans-serif, system-ui)
**Body Font:** IBM Plex Sans
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SF Mono, Menlo)

**Character:** One family doing all the work. Plex Sans 600 with negative tracking carries every
heading at a scale the app never uses; Plex Mono appears only where the text is literally code.

### Hierarchy
- **Display** (600, 44 to 88px fluid, 0.98, −0.032em): the hero headline only.
- **Headline** (600, 34 to 64px fluid, 1.02, −0.032em): section heads, balanced, closing on the
  2px ink rule.
- **Title** (600, 28 to 44px fluid, 1.05, −0.028em): the two doors in the close.
- **Claim** (600, 20 to 28px fluid, 1.2, −0.02em): the principle claims in the left column.
- **Entry** (400, 17 to 21px fluid, 1.5): the operations lane. Larger than body because it is
  the page the operations reader reads.
- **Lede** (400, 17 to 20px fluid): the hero sentence, max 34rem, in soft ink.
- **Body** (400, 17px, 1.6, Plex `ss02`): running text; definitions cap at 40rem.
- **Small** (15px): the engineering lane, nav, buttons, table body, stamps.
- **Label** (500, 13px): lane heads, column labels, the plate caption, spine pills.
- **Code** (Plex Mono 400, 12.5px in blocks at 1.55; 0.875em inline): step keys, HTTP, JSON.
  Tabular numerals.

**The One Family Rule.** Plex Sans for every heading and the wordmark, Plex Mono for code. No
serif, no second display face, no system face standing in at display size.

**The Sentence Case Rule.** Headings, labels and buttons are sentence case. Labels sit in muted
13px 500, never uppercase or letter-spaced.

## Layout

A centred column, max **84rem**, with a fluid gutter (16 to 40px). Sections are separated by
space, 80 to 144px, not by boxes.

- **Hero:** a 5:7 grid, copy left and the flow plate right, at least one viewport tall below the
  top bar.
- **Section head:** a 7:5 grid, headline left and the explaining paragraph right, aligned to the
  baseline end, closed by a 2px ink rule.
- **Twin-lane ledger:** three columns, operations | spine | engineering, with the spine fixed at
  160 to 208px and the lanes equal. Each step is one row, ruled by a hairline, so the same entry
  sits on the same line in both lanes. Lane heads stick under the top bar.
- **Claim and mechanism:** principles and deployment facts are 5:7 definition rows, ruled.
- **Intake:** 4:4:5 rows (source, endpoint in mono, note), ruled.
- **Close:** two doors side by side, a hairline between them, between a 2px ink rule above and a
  3px double rule below.
- **Top bar:** 56px, sticky, paper at 94% with a light blur, hairline beneath.

### Responsive
- **Below 64rem:** the nav links hide, the hero and section heads stack to one column, the flows
  table becomes stacked entries (model and channel inline, separated by a middle dot), intake
  rows stack.
- **Below 44rem:** the hero swaps to a narrow plate (two levels to a line instead of four);
  "Sign in" hides. The ledger becomes one lane at a time: a sticky Operations | Engineering switch
  replaces the lane heads, each row is a 6.5rem spine beside the chosen lane, and in the
  engineering reading the capture switch spans the row above. Definition rows, the close and its
  doors stack.

**The Same-Line Rule.** In the ledger, a step's operations entry, its pill and its engineering
entry share one row. On a phone the rows keep their place; only the lane changes.

## Elevation & Depth

Flat by default, as Ledger is. Separation is a hairline or a ruled row; depth is a tonal step
(sheet against paper, card under code). Two shadows exist, both soft and ink-tinted.

### Shadow Vocabulary
- **Plate lift** (`0 1px 0` ink at 4%, plus `0 18px 40px -24px` ink at 30%): the hero flow plate,
  the one object on the page that sits on the desk rather than in the book.
- **Button press** (`0 1px 2px` ink at 18%): ink button hover only.

**The One Sheet Rule.** Only the hero plate is lifted. Every other surface is ruled or toned, and
the band inverts rather than elevates.

## Shapes

- **6px** (`--radius`): buttons, the lane switch, code entries, the skip link.
- **5px:** flow nodes on the plate and spine pills, the app's node shape.
- **10px** (radius + 4px): the hero plate.
- **Round:** the capture outcome choices, the replay token, the outcome dot.
- **3px:** focus outlines.

Lines carry the structure. Hairlines (1px rule) for rows and frames; 1.25px ink on run nodes and
pills; a 1.5px ink spine; a 2px ink rule under section heads and above the close; a 3px double
rule where an account closes.

**The Double Rule Rule.** A double rule means "this account is closed": under the close's two
doors, and under the End node pill when an order fails. It is never decoration.

## Components

### Buttons
- **Shape:** gently rounded (6px).
- **Primary:** ink ground, paper text, 500. 36px tall in the top bar, 48px (`large`) in the hero
  and close.
- **Hover / Focus:** the ground mixes 12% toward paper and gains the button-press shadow over
  160ms; focus is a 2px registrar-blue outline 3px out.
- **Secondary:** transparent with an `input` hairline and ink text; hover fills with card and
  darkens the border to soft ink.
- **Text link:** registrar blue, 500, underlined at 40% of the link, full on hover. It pairs with
  a primary button as the second door.

### The ledger lines plate (`FlowPlate.astro`)
The hero illustration is the shipped storefront template, levelled by the core planner and set as
ledger lines: four levels to a line (two on a phone), wrapping like text. An edge that crosses a
line break runs out to the right margin, down into the gap and back to the left margin, a
carriage return. The run's node sits on each column's first row with an ink border, a category
tick and its label; branches it didn't take hang below, smaller, as ghost nodes (dashed edge
hairline, no fill, muted label). Run edges are 1.6 ink; untaken edges are dashed `edge` at 70%.
Marks at the top right: an amber clock on waits, a rust undo arrow on steps with a compensation,
a green dot on the outcome. The plate sits on the dotted sheet (16px grid) with a ruled caption:
counts read from the template, a sentence on this run, and a line-sample legend.

### The twin-lane ledger (`Ledger.astro`)
One order read twice. Each row is one step: the operations entry at entry size in ink, the
engineering note in soft ink with its step log as a code entry, and between them the spine.

- **Spine:** a sheet-toned column with hairlines either side and a 1.5px ink line down its
  centre; it starts at the first pill. Node pills sit on it: node ground, 1.25px ink border, 5px
  corners, 13px 500, a 4px category square at the left.
- **Capture switch:** "Then the capture fails | succeeds", a sentence with two round choices.
  The chosen one fills with its status (red or green) and paper text. CSS `:has()` does the
  switching, so it works without script. "fails" is chosen by default.
- **Wait pill:** an amber border.

### Reversals
When the capture fails, every step with a compensation is reversed the way a ledger reverses an
entry: the original is struck through, not removed, and a counter-entry is posted on the same
line.

- **Operations lane:** the entry takes a 1px rust strike; beneath it a rust stamp (undo arrow and
  a sentence: "Stock released").
- **Engineering lane:** the step log is struck in rust and dimmed to muted; beneath it the
  counter-entry in rust mono (`rollback reserve#0 → released`).
- **Spine:** the pill turns rust (border and text) and the spine through that row turns rust and
  dashed.
- **Close of the account:** the spine stops at the End node, which carries a red border and a red
  3px double rule beneath it.

**The Strike-Not-Erase Rule.** A reversed entry stays legible under its strike, and its
counter-entry sits on the same line. Undo never deletes the record.

### The inverted ink band
The deployment section is set in the other look: on a light page the band takes the full ink
night palette (dark paper, light ink, dark rules); in ink night it takes the light palette. It
runs edge to edge with its content held on the page column, 64 to 112px of padding top and
bottom, and its section head still closes on an ink rule (the band's ink). It is a palette swap,
not a tint.

### Close and doors
Two doors, ruled like a ledger's totals: a 2px ink rule above, a 3px ink double rule below, a
hairline between. Each door has a title, a sentence in soft ink and its action: the ink button
for a deployment; the secondary button and a text link for the docs.

### Navigation
The wordmark (the OrderLoop mark plus "OrderLoop", 600, −0.015em), muted text links that go ink
on hover, then the theme switch (a 32px icon button, sun or moon by the look it switches to), a
quiet "Sign in" and the ink button. The theme choice is the app's (`ol-theme`), applied before
first paint.

### Motion
One ease for everything, an expo-style ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`). Nothing
enters on scroll; only the run moves.

- **Token ride (hero, once on load):** the run edges and nodes start unlit (nodes at 32%). After
  350ms a registrar-blue token with a sheet-coloured ring rides each run edge in turn, easing
  out, 110ms plus 0.35ms per unit of length, capped at 520ms, so a carriage return takes longer.
  Each node lights (240ms) as the token reaches it; each edge draws (260ms). A wait holds the
  token 420ms and pulses its border amber (900ms). The plate settles to the finished run.
- **Held rollback (ledger):** if the capture row starts below the fold, the reversal is held
  unstruck until the row is 60% on screen, then plays newest first: ship, reserve, authorize,
  280ms apart after a 240ms lead. Strikes and pill colours transition over 360ms; stamps arrive
  over 520ms from 6px left, transparent and lightly blurred.
- **Reduced motion and no script:** no replay, no hold, no transitions; smooth scrolling is off.
  The HTML is already the finished run and the reversed ledger.

**The Finished-State-First Rule.** Every animation starts from the state the HTML already shows.
Motion is a replay of the record, never the only way to see it.

## Do's and Don'ts

### Do
- **Do** take every colour from the tokens Base.astro writes; a new colour starts in
  `apps/web/app/app.css`, then `packages/design/src/tokens.ts`.
- **Do** draw OrderLoop's mechanism from real data: the template from `@orderloop/core`, levelled
  by the planner, with real step keys.
- **Do** rule rows with hairlines and close sections on ink; keep the double rule for closed
  accounts.
- **Do** show a reversal as a rust strike plus a counter-entry on the same line.
- **Do** make the static, reduced-motion state complete before adding any motion.

### Don't
- **Don't** hand-copy token values into `site.css` or the page.
- **Don't** use green for anything but "succeeded", or a status hue for decoration.
- **Don't** add uppercase or letter-spaced labels, or an eyebrow above a heading.
- **Don't** lift anything but the hero plate; no gradients, coloured side edges, or translucency
  beyond the top bar's 94% paper.
- **Don't** use Plex Mono for prose or labels; it is for step keys, JSON and HTTP.
- **Don't** add scroll-triggered entrances or motion that isn't the run.
- **Don't** borrow styling from other projects (durablefibers, Supabase); Ledger is this
  product's own.
