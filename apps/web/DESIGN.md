---
name: OrderLoop web app
description: The operator console. Ledger on a desktop, an iPad and an iPhone, in a tab or on the Home Screen.
---

# Design System: OrderLoop web app

## Overview

The console where people watch orders, decide approvals and draw flows. Its visual system is
**Ledger**: shadcn's base-luma preset (neutral greys, Inter, pill buttons and fields) on the Radix
primitives in `packages/ui`, with status tokens (`ok`, `wait`, `bad`, `undo`, `run`, `idle`, `ai`)
that mean one thing each. The tokens live in `apps/web/app/app.css`, are mirrored in
`packages/design/src/tokens.ts`, and the docs site's reading of them is recorded in
`apps/docs/DESIGN.md`. This file is about how the app is laid out and operated across screens.

## Screens and breakpoints

Tailwind's default breakpoints, read as devices:

| Width | Typically | What changes |
|---|---|---|
| below `sm` (640px) | iPhone upright | Top bar shows icons only |
| below `md` (768px) | phones, either way up | Bottom tab bar; tables stack into cards; the Commerce jump links stick under the top bar |
| `md` to `lg` (768–1023px) | iPad upright | Links in the top bar, scrolling sideways with a fade at the edge; Assistant, New order and the account name are icons |
| `lg` and up (1024px) | iPad on its side, desktop | The full flow editor; the order page's graph beside its panels; the assistant as a column |

Size and hint by what is pointing, not by width: `touch:` is a coarse pointer (a finger), `fine:` a
mouse or trackpad (an iPad with a trackpad reports fine). `short:` is a phone on its side (landscape,
under 32rem tall, under 64rem wide).

## The shell

- **Top bar:** 3rem plus the status bar's inset (`--shell-h`), sticky, with a rule under it. The
  wordmark, the main links from md, then Assistant, New order, theme and account.
- **Tab bar (below md):** Overview, Orders, Approvals (with its count), Flows, and More: the pages
  an operator reaches for, in thumb reach. 3.5rem plus the home indicator (`--tabbar-h`); in
  `short:` 2.75rem with the labels for screen readers only. More is a bottom sheet with the other
  pages, the theme and the account's pages, and it closes when a page is chosen.
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

## Components

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

- **Do** check a layout change with `pnpm --filter @orderloop/web e2e` (WebKit as an iPhone and an
  iPad, both ways up, and a desktop). See `docs/testing.md`.
- **Do** give a small control `hit-area` rather than growing it.
- **Do** put a phone's most frequent action within thumb reach: the tab bar, a bottom sheet.
- **Do** keep one scroll region at a time on a phone.

### Don't

- **Don't** read `env(safe-area-inset-*)` directly, or hard-code 3rem for the top bar.
- **Don't** set a field under 16px for touch, or show a keyboard shortcut to a finger.
- **Don't** let a narrow screen change what it can't save (the flow editor below lg).
- **Don't** interrupt work to suggest installing the app.
- **Don't** port another product's look; Ledger is this product's.
