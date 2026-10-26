---
name: OrderLoop web app
description: The operator console. Ledger on a desktop, an iPad and an iPhone, in a tab or on the Home Screen.
colors:
  paper: "oklch(1 0 0)"
  ink: "oklch(0.145 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.52 0 0)"
  rule: "oklch(0.922 0 0)"
  input: "oklch(0.922 0 0)"
  ring: "oklch(0.556 0 0)"
  link: "oklch(0.47 0.13 256)"
  destructive: "oklch(0.577 0.245 27.325)"
  ok: "oklch(0.455 0.105 152)"
  wait: "oklch(0.49 0.115 62)"
  bad: "oklch(0.5 0.185 28)"
  undo: "oklch(0.485 0.135 42)"
  idle: "oklch(0.48 0 0)"
  ai: "oklch(0.49 0.16 310)"
  paper-dark: "oklch(0.145 0 0)"
  card-dark: "oklch(0.205 0 0)"
  ink-dark: "oklch(0.985 0 0)"
  muted-dark: "oklch(0.269 0 0)"
  muted-foreground-dark: "oklch(0.708 0 0)"
  link-dark: "oklch(0.76 0.11 250)"
typography:
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  section-title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  ui:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
  caption:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.05em"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  2xl: "1.125rem"
  3xl: "1.375rem"
  4xl: "1.625rem"
  full: "9999px"
spacing:
  gutter-phone: "1rem"
  gutter: "1.5rem"
  page-width: "87.5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.4xl}"
    height: "2.25rem"
    padding: "0 0.75rem"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.4xl}"
    height: "2.25rem"
    padding: "0 0.75rem"
  input:
    textColor: "{colors.ink}"
    rounded: "{rounded.3xl}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.4xl}"
  tile:
    backgroundColor: "{colors.muted}"
    rounded: "{rounded.2xl}"
    padding: "1rem"
  status-badge:
    rounded: "{rounded.full}"
    padding: "0.125rem 0.5rem"
---

# Design System: OrderLoop web app

## Overview

The console where people watch orders, decide approvals and draw flows. Its visual system is
**Ledger**: shadcn's base-luma preset (neutral greys, Inter, pill buttons and fields) on the Radix
primitives in `packages/ui`, with status tokens (`ok`, `wait`, `bad`, `undo`, `run`, `idle`, `ai`)
that mean one thing each. The tokens live in `apps/web/app/app.css`, are mirrored in
`packages/design/src/tokens.ts`, and the docs site's reading of them is recorded in
`apps/docs/DESIGN.md`. This file is about how the app is laid out and operated across screens.

## Colors

Neutral greys with no tint carry everything; colour is reserved for one blue and for status.

### Primary
- **Ink** (`primary`, near-black): primary buttons, the New order button, the active tab's rule. Ink
  is the brand; there is no accent colour behind it.

### Secondary
- **Work blue** (`link`): links, live work (`run`), the slow-page bar and the caret. Never a fill
  for a button.

### Neutral
- **Paper** (`paper`): the page and the card. In dark the page is near-black and cards lift a step
  (`card-dark`).
- **Muted** (`muted`): tiles, segmented tracks, hover fills.
- **Muted text** (`muted-foreground`): secondary text and captions. Set to hold 4.5:1 on paper,
  on muted and on a tile.
- **Rule** and **Input** (`rule`, `input`): hairlines, and the fill of fields (at half strength).
- **Ring** (`ring`): the focus edge on fields and buttons, dark enough to hold 3:1 on paper and on
  muted fills. The page-wide focus outline is ink.

### Status
`ok` succeeded, `wait` waits on a person or event, `bad` failed, `undo` rolled back, `idle` ended
otherwise or not started, `ai` a model's work, `run` (the work blue) running. Each badge, dot and
chart series for a status uses its token through `var()`, so it switches with the theme.

### Named Rules
**The Green Means Done Rule.** `ok` is the only green, and it means "succeeded". No green brand,
no green button, no green decoration.

**The One Meaning Rule.** A status colour is never used decoratively. If it isn't a status, it is
grey.

## Typography

**Body Font:** Inter Variable (with the system sans)
**Label/Mono Font:** IBM Plex Mono, for order refs, ids, code and figures read as data

**Character:** one quiet sans for everything, set small and dense for operators, with Plex Mono
only where a value must be read character by character.

### Hierarchy
- **Title** (600, 1.75rem, 1.25, -0.015em): a page's h1. It wraps; it is never truncated.
- **Section title** (600, 15px, 1.3): a card's heading, in sentence case.
- **Body** (400, 0.875rem): running text, rows, fields.
- **UI** (400, 0.8125rem, `text-ui`): the top bar, segmented controls, compact controls.
- **Caption** (500, 0.6875rem: 11px, 0.05em, UPPERCASE): field, column and fact labels. The only uppercase in
  the product.
- **2xs** (0.6875rem, `text-2xs`): counts and tags in the bars.

### Named Rules
**The Sentence Case Rule.** Titles, buttons and menu items are sentence case. Only captions are
uppercase, and never in mono.

**The Scale Lives In The Theme Rule.** Sizes come from the theme (`text-ui`, `text-2xs`,
Tailwind's steps), not hand-written pixel values, so they grow with the reader's text size.

## Screens and breakpoints

Tailwind's default breakpoints, read as devices:

| Width | Typically | What changes |
|---|---|---|
| below `sm` (640px) | iPhone upright | Top bar shows the mark and Assistant as icons |
| below `md` (768px) | phones, either way up | Bottom tab bar; tables stack into cards; the Commerce jump links stick under the top bar |
| `md` to `lg` (768–1023px) | iPad upright | Links in the top bar; Assistant, New order and the account name are icons |
| `lg` and up (1024px) | iPad on its side, desktop | The full flow editor; the order page's graph beside its panels; the assistant as a column |

Size and hint by what is pointing, not by width: `touch:` is a coarse pointer (a finger), `fine:` a
mouse or trackpad (an iPad with a trackpad reports fine). `short:` is a phone on its side (landscape,
under 32rem tall, under 64rem wide).

## The shell

- **Top bar:** 3rem plus the status bar's inset (`--shell-h`), sticky, with a rule under it. The
  wordmark, the main links from md, then Assistant, New order (from md) and account.
- **Its links:** the day's work (Overview, Orders, Approvals, Carts), a hairline, Flows, then
  **More**: links that didn't fit, reference pages (Commerce, Performance), plugins' pages under
  "From plugins", and for admins the workspace's pages under "Workspace" (Team and roles, Audit
  log, Plugins). While you're on one of its pages, More reads as that page, underlined; it carries
  the approvals count while Approvals is inside it. A tab marks as soon as it is chosen, not when
  its page arrives. Focus outlines on the links sit inside them, clear of the rule.
- **Fitting the bar:** it never scrolls or overlaps, whatever the window or text size
  (`useFittingBar`). An invisible ruler holds every link, and each way More can read, at natural
  width. Before paint, labels give way first, in this order: the wordmark, the account's name,
  Assistant's words and hint, New order's words (each stays an icon with its name); only then do
  links fold into More from the right. The links' room never gets narrower than More. What gave way
  is marked on the bar as `data-squeeze` and the labels hide by it. Before hydration (or without
  JavaScript) the row clips rather than drawing under the controls.
- **Approvals count:** a filled `wait` pill, 99+ past two digits, in the top bar, tab bar and
  More alike: the bar's one call for attention.
- **New order:** ink, except on Approvals and Flows, where it steps back to an outline. From md to
  lg it is an icon with a `title`.
- **Account:** its menu holds who is signed in, their Account page, Keyboard shortcuts (with a
  fine pointer), the theme and signing in or out; the workspace's pages are in More. The button names who: a person's name, Workspace, or with sign-in off the role everyone acts
  as ("Admin, no sign-in"); its accessible name is that plus "account menu", and its `title` the
  full identity.
- **Shortcuts** are written for the device: ⌘J on Apple, Ctrl+J elsewhere (`useShortcutLabel`).
  The Assistant's hint shows from xl with a fine pointer and is hidden from screen readers, which
  get `aria-keyshortcuts`. G then a letter goes to a page (H Overview, O Orders, A Approvals, C
  Carts, F Flows, P Performance) and ? opens the list of every shortcut; they follow
  `pageShortcut`'s rules and run before a page's own keys.
- **Transitions** in the bars name their properties (`tint`), never `transition-colors`, which
  would fade the focus outline in.
- **One order everywhere:** the top bar, the tab bar and More list pages in `NAV`'s order.
- **New order on a phone:** a floating pill (`shadow-float`) above the tab bar on the right, on
  the overview and the orders list only; main pads its foot so the last row clears it.
- **Tab bar (below md):** Overview, Orders, Approvals (with its count), Carts, and More: the day's
  work, in thumb reach; a phone keeps up and decides, and only reviews flows. 3.5rem plus the home
  indicator (`--tabbar-h`); in `short:` 2.75rem with the labels for screen readers only. More is a
  bottom sheet grouped like the desktop: Pages, From plugins and Workspace (as in More), then
  Account, the theme and signing in or out (as in the account menu). It closes when a page is chosen.
- **Main** pads its foot by `--tabbar-h`. A full-height page (the flow editor, the order page at
  lg) is `calc(100dvh - var(--shell-h))`; never hard-code the bar heights.
- **Assistant:** a column beside the page at lg; below that a sheet between the top bar and the
  tab bar. While the on-screen keyboard is up (`data-keyboard` on `<html>`, from
  `useVisualViewport`) it takes exactly the area above the keyboard.
- **Slow pages:** a navigation that takes over 400ms draws a link-blue rule sweeping under the top
  bar and marks main `aria-busy`. Quicker ones show nothing.
- **Route announcer:** after a client-side navigation, the new page's h1 is read out in a polite
  live region. Focus stays where it was.

## Safe areas

`root.tsx` sets `viewport-fit=cover`, so the installed app and a phone on its side draw under the
status bar, the notch and the home indicator. The insets are `--safe-top`, `--safe-right`,
`--safe-bottom` and `--safe-left` (0 elsewhere). Pad with the utilities: `pt-safe-*`, `pb-safe-*`,
`px-safe-*`, `pr-safe-*`, `pl-safe-*` give a page's own spacing or the inset, whichever is
bigger (`pb-safe-3` is 0.75rem, or the home indicator's height). Read the insets through the
variables, never `env()` directly: the device tests fake a notch by setting them.

## Touch

- **Targets:** 44px for a finger. A small control keeps its drawn size and gets `hit-area`, an
  invisible box grown to 2.75rem on a coarse pointer. The shared buttons have it at every size;
  raw buttons and links in the bars add it.
- **Fields:** 16px on a touch screen whatever their classes say (an unlayered rule in app.css), so
  iOS never zooms into one. Search fields get `enterKeyHint="search"` and no autocorrect.
- **No** tap highlight, double-tap delay, text inflation or rubber-band at the page's edges
  (live pages update themselves; pull-to-refresh would only get in the way).
- **Keyboard hints** (⌘J, Enter sends, J/K, "/") show only with `fine:`. Single-key shortcuts go
  through `pageShortcut`, which ignores them with ⌘, Ctrl or Alt held, while typing, and while a
  dialog, menu or sheet is open: an iPad with a keyboard has both.
- **The composer:** on a touch screen Return is a new line and the Send button sends; ⌘ or Ctrl
  with Enter always sends.

## Screens that change shape

- **Flow editor:** at lg it builds. On touch, a palette item is tapped in (dragging is unreliable
  on iPadOS), node handles grow and carry a 32px target, and a connection snaps from 40px. Below lg
  it is review-only, saying so: nothing on screen can change the flow.
- **Order page:** at lg the graph sits beside Actions, Activity, Details and Node. Below lg the
  graph is a tab of its own, so each view has the screen and the page is the one scroll region.
- **Tables:** below md, `table-stack` makes each row a card: its first cell on a line of its own,
  the others wrapping beneath it, each named by its `data-label`. A table that already fits keeps
  its rows.

## Elevation & Depth

Lifted, lightly. A card sits on the page with a faint ring and a soft two-layer shadow; inside it,
depth is tonal: tiles are a muted step, not another shadow. In dark the shadow is dropped and the
ring alone separates a card.

### Shadow Vocabulary
- **Card** (`box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 5%, transparent), 0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.06)`): every panel (`card`).
- **Raised segment** (`shadow-sm`): the chosen segment of a segmented control.
- **Float** (`shadow-float`): a control over a scrolling page, a phone's New order. None in dark.

### Named Rules
**The No Nested Cards Rule.** Inside a card, group with tiles or rows, never another card.

## Shapes

Generous and round. The radius base is 0.625rem on a multiplying scale: cards are 4xl, tiles 2xl,
one-line fields 3xl. Buttons, one-line fields, badges, segmented controls and icon buttons are
pills. Hairlines divide rows inside a card; cards themselves have no border.

**The Pill Rule.** Anything you press or that labels a status is fully round. Square corners are
for code and data blocks only.

## Components

- **Buttons** (`packages/ui/src/button.tsx`): pills. Primary is an ink fill with paper text; outline is a
  rule on paper; ghost fills muted on hover; link is the work blue. Focus turns the edge to `ring`
  with a soft halo. Every size carries `hit-area`.
- **Fields** (`input.tsx`, `textarea.tsx`, `native-select.tsx`): filled pills (`input` at half
  strength), no rest border. Focus: the `ring` edge and halo. Invalid: the destructive edge.
- **Segmented** (`segmented.tsx`): a radio group drawn as a muted pill track; the chosen segment
  is raised on paper. Arrow keys move the choice.
- **Card and tile** (`card`, `tile` in app.css): the panel and the step inside it. `Section`
  (`components/page.tsx`) is a card with a section title and optional actions.
- **Status badge** (`components/status.tsx`): a pill tinted 11% in the status colour; an ending
  that went badly is ruled in the colour with a mark (✕ or undo) instead of tinted, so it reads
  apart without colour.
- **Counts** (pending approvals in the bars): `wait` pills.
- **Confirm** (`components/confirm.tsx`): an "are you sure?" where the action was, never a modal.
  The safe choice has focus, Escape backs out of the newest one, and focus goes back to what
  asked. Its actions are children, so it sits inside the caller's form.
- **Sheet** (`packages/ui/src/sheet.tsx`): from the bottom on a phone, capped at 85dvh and scrolling
  inside, with its corners rounded at the top; from the side otherwise. It pads for the safe areas.
- **Share** (`components/share-button.tsx`): the system share sheet where there is one, else Copy
  link.
- **Install hint** (`components/install-hint.tsx`): on Account only, on an iPhone or iPad in
  Safari, until it's dismissed. iOS never offers Add to Home Screen itself.

## Installed

The web app manifest and the apple-touch-icon put it on the Home Screen as its own app
(`standalone`). The icons are rendered from the favicon's mark by `apps/web/scripts/icons.sh`, ink on
paper and opaque; rerun it after the mark or the paper colour changes, and change `THEME_COLOR` in
`root.tsx` and the manifest's colours with them. `theme-color` follows the chosen theme, not only the
system's. The status bar style is `default`. There is no service worker: nothing works offline, and
actions must reach the engine.

## Do's and Don'ts

### Do

- **Do** keep text at 4.5:1 and focus edges at 3:1, in both themes, on the surface they sit on
  (paper, muted, tile).
- **Do** take sizes from the theme (`text-ui`, `text-2xs`, `max-w-page`).
- **Do** check a layout change with `pnpm --filter @orderloop/web e2e` (WebKit as an iPhone and an
  iPad, both ways up, and a desktop). See `docs/testing.md`.
- **Do** give a small control `hit-area` rather than growing it.
- **Do** put a phone's most frequent action within thumb reach: the tab bar, a bottom sheet.
- **Do** keep one scroll region at a time on a phone.

### Don't

- **Don't** fade the focus ring below 3:1, or remove the outline without drawing an edge.
- **Don't** put a status colour on something that isn't a status.
- **Don't** read `env(safe-area-inset-*)` directly, or hard-code 3rem for the top bar.
- **Don't** set a field under 16px for touch, or show a keyboard shortcut to a finger.
- **Don't** let a narrow screen change what it can't save (the flow editor below lg).
- **Don't** interrupt work to suggest installing the app.
- **Don't** port another product's look; Ledger is this product's.
