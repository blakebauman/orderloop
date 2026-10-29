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
    rounded: "{rounded.4xl}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.2xl}"
  tile:
    backgroundColor: "{colors.muted}"
    rounded: "{rounded.xl}"
    padding: "1rem"
  status-badge:
    rounded: "{rounded.full}"
    padding: "0.125rem 0.5rem"
---

# Design System: OrderLoop web app

## Overview

The console where people watch orders, decide approvals and draw flows. Its visual system is
**Ledger**: shadcn's base-maia preset (neutral greys, Inter, pill buttons and fields) on the Radix
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
- **Rule** and **Input** (`rule`, `input`): hairlines, and the edge and faint fill of fields.
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

**The Overdue Rule.** On a wait's age or count, `wait` means overdue: past the waiting step's own
timeout or deadline (the index's `waiting_due`, `isOverdue` in `lib/where.ts`), and the word
"overdue" sits beside it. A wait still on time reads in the normal or muted colour however long it
has run, and a step with no deadline (a timer) is never overdue. The Waiting badge and dot keep
`wait`: that is the status, not an age.

## Typography

**Body Font:** Inter Variable (with the system sans)
**Label/Mono Font:** IBM Plex Mono, for order refs, ids, code and figures read as data

**Character:** one quiet sans for everything, set small and dense for operators, with Plex Mono
only where a value must be read character by character.

### Hierarchy
- **Title** (600, 1.75rem, 1.25, -0.015em): a page's h1. It wraps; it is never truncated.
- **Section title** (600, 15px, 1.3): a card's heading, in sentence case.
- **Body** (400, 0.875rem): running text, rows, fields.
- **UI** (400, 0.8125rem, `text-ui`): the header, segmented controls, compact controls.
- **Caption** (500, 0.6875rem: 11px, 0.05em, UPPERCASE): field, column and fact labels, and the group
  labels in menus and sheets (the `caption` utility alone; a menu label sets no size of its own). The only uppercase in
  the product.
- **2xs** (0.6875rem, `text-2xs`): counts and tags in the bars.

### Named Rules
**The Sentence Case Rule.** Titles, buttons and menu items are sentence case. Only captions are
uppercase, and never in mono.

**The Scale Lives In The Theme Rule.** Sizes come from the theme (`text-ui`, `text-2xs`,
Tailwind's steps), not hand-written pixel values, so they grow with the reader's text size.

**The Measure Rule.** Running text, a page's intro under its title (`PageHeader`) and the xs helper
lines in sections alike, is held to `max-w-measure` (55ch, `--container-measure` in app.css): Inter
averages about 0.8ch a character, so that is 65 to 75 characters a line at any size. Not a
hand-written `max-w-[…ch]`.

## Screens and breakpoints

Tailwind's default breakpoints, read as devices:

| Width | Typically | What changes |
|---|---|---|
| below `sm` (640px) | iPhone upright | The header shows the mark and Assistant as icons |
| below `md` (768px) | phones, either way up | Bottom tab bar, no sidebar; tables stack into cards (see Tables); the Commerce jump links stick under the header |
| `md` to `lg` (768–1023px) | iPad upright | The sidebar is an icon rail beside the page and opens over it |
| `lg` and up (1024px) | iPad on its side, desktop | The full sidebar (the reader can collapse it); the full flow editor; the order page's graph beside its panels; the assistant as a column |
| `xl` and up (1280px) | desktop | The full sidebar and the assistant's column side by side; below this, opening the assistant rails the sidebar |

Size and hint by what is pointing, not by width: `touch:` is a coarse pointer (a finger), `fine:` a
mouse or trackpad (an iPad with a trackpad reports fine). `short:` is a phone on its side (landscape,
under 32rem tall, under 64rem wide).

## The shell

- **Sidebar (from md):** shadcn's Sidebar (radix-maia), ported to `packages/ui/src/sidebar.tsx`
  and composed in `shell.tsx` (`AppSidebar`). Full height on its own ground (`--sidebar`, half a step
  under the paper; `.205` in dark, a step above the page), with a rule. From the top: the header
  row, on the header's line (its height, its inset, its rule), whose mark is the `SidebarTrigger`
  (named "Sidebar", ⌘\ or Ctrl+\); the day's work (Overview, Orders, Approvals, Carts) with no
  label; then groups labelled as captions: Build (Flows), Reference (Commerce, Catalog,
  Performance), From plugins (past six, the first five and "N more"), and for admins Workspace (Team
  and roles, Audit log, Plugins); the account in the footer; `SidebarRail` on its edge. Rows are
  `SidebarMenuButton`s, an icon and a name in `NAV`'s order; the page you're on is
  `--sidebar-accent` (a step deeper than the preset's, so it reads on the ground) and 500, with
  `aria-current`, marked as soon as it is chosen, not when its page arrives. On touch every row is
  44px tall. The approvals count is a `SidebarMenuBadge`.
- **Expanded or a rail:** 16rem, or a 3.25rem rail of icons (`--sidebar-width`,
  `--sidebar-width-icon` plus the notch's inset). The reader's choice is shadcn's `sidebar_state`
  cookie, read by the shell's loader, so the server draws it at the right width. Below lg, on a
  canvas (the flow editor, an order) and beside the assistant's column below xl, the provider is in
  `overlay`: the sidebar stays a rail and its toggle opens it over the page (`peek`, with
  `shadow-overlay`), leaving the choice alone; Escape, a press outside it or a navigation closes it.
  Below lg it is also a rail by CSS, so an iPad draws it right before hydration. The icon-only look
  follows the drawn width (a container query below 8rem), not `data-state`: names go to screen
  readers and a tooltip, group labels keep their height as hairlines, the count becomes a `wait`
  dot, and icons stay at the same x, so nothing moves as it narrows. Width changes take the travel
  time on the arriving ease; reduced motion jumps. It is its own view-transition layer
  (`vt-sidebar`), still while pages change. Not shadcn's: no mobile Sheet (phones have the tab
  bar), and ⌘\ rather than ⌘B, which Firefox keeps for its bookmarks.
- **Header:** 3rem plus the status bar's inset (`--shell-h`), sticky over the page, with a rule
  under it. From md it holds only what acts on the page: Assistant and New order. Pages carry their
  own crumbs, so it doesn't name the page. Below md it starts with the mark (a link to Overview).
- **Titles in menus and sheets** (the account menu's who, a sheet's title) are 600 with
  `tracking-title`, the title tier, so they read as headers over 400 items; hints (⌘J, ?) are
  11px/400 muted everywhere except the shortcuts list's boxed keys.
- **Approvals count:** a filled `wait` pill, 99+ past two digits, in the sidebar, tab bar and
  More alike (a `wait` dot on the rail): the shell's one call for attention.
- **New order:** ink, except on Approvals and Flows, where it steps back to an outline.
- **Account:** the sidebar's foot. Its menu (upward, or to the right of a rail) holds who is signed
  in, their Account page, Keyboard shortcuts (with a fine pointer), the theme and signing in or
  out; the workspace's pages are the sidebar's. The button names who: a person's name, Workspace, or with sign-in off the role everyone acts
  as ("Admin, no sign-in"); its accessible name is that plus "account menu", and its `title` the
  full identity.
- **Shortcuts** are written for the device: ⌘J and ⌘\ on Apple, Ctrl+J and Ctrl+\ elsewhere
  (`useShortcutLabel`).
  The Assistant's hint shows from xl with a fine pointer and is hidden from screen readers, which
  get `aria-keyshortcuts`. G then a letter goes to a page (H Overview, O Orders, A Approvals, C
  Carts, F Flows, P Performance) and ? opens the list of every shortcut; they follow
  `pageShortcut`'s rules and run before a page's own keys.
- **Transitions** in the bars name their properties (`tint`), never `transition-colors`, which
  would fade the focus outline in.
- **One order everywhere:** the sidebar, the tab bar and More list pages in `NAV`'s order.
- **New order on a phone:** a floating pill (`shadow-float`) above the tab bar on the right, on
  the overview and the orders list only; main pads its foot so the last row clears it, and the
  page's `scroll-padding-bottom` keeps what focus or a link scrolls to clear of it.
- **Tab bar (below md):** Overview, Orders, Approvals (with its count), Carts, and More: the day's
  work, in thumb reach; a phone keeps up and decides, and only reviews flows. 3.5rem plus the home
  indicator (`--tabbar-h`); in `short:` 2.75rem with the labels for screen readers only. More is a
  bottom sheet grouped like the sidebar: Pages, From plugins and Workspace, then
  Account, the theme and signing in or out (as in the account menu). It closes when a page is chosen.
- **Main** pads its foot by `--tabbar-h`. A full-height page (the flow editor, the order page at
  lg) is `calc(100dvh - var(--shell-h))`; never hard-code the bar heights.
- **Assistant:** a column beside the page at lg; below that a sheet between the header and the
  tab bar, beside the rail from md. While the on-screen keyboard is up (`data-keyboard` on `<html>`, from
  `useVisualViewport`) it takes exactly the area above the keyboard. Both slide in 200ms on an
  exponential ease-out (`cubic-bezier(0.16,1,0.3,1)`), by transform and opacity only: the sheet
  from the right edge; the column takes its 400px at once (the page narrows in one layout, not one
  per frame) while its content slides in from the right, and on closing gives the width back only
  after the content has slid out. Nothing inside rewraps. Reduced motion shows and hides it at once. An action waiting for the person's
  confirmation is pinned above the composer (`wait` tint) until it is answered.
- **Slow pages:** a navigation that takes over 400ms draws a link-blue rule sweeping under the
  header and marks main `aria-busy`. Quicker ones show nothing.
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

## Tables

Every data table is `Table` from `packages/ui/src/table.tsx`, with its parts (`TableHead`,
`TableBody`, `TableFoot`, `Tr`, `Th`, `Td`, `TableEmpty`); never a hand-styled `<table>`.

- **Cells** are padded by the table (app.css, at zero specificity, so a cell's own classes win).
  `edge="card"` runs edge to edge inside a card, its outer columns inset 1rem; `edge="flush"` lines
  them up with the text of a padded panel.
- **Headers** are captions, `scope="col"`. A column without a name (row actions) still gets one
  for screen readers. The column a list is sorted by is ink, with its direction drawn; a header
  that can sort is a link to that order.
- **Figures** (`numeric`) are right-aligned, tabular and unbroken. Ids and SKUs are mono and never
  wrap; an order is always `orderRef` (`#abc123`).
- **Status** in a cell is a badge: `StatusBadge` for orders and steps, `ToneBadge` for another
  vocabulary (records, carts, a paused promotion), never coloured text alone.
- **Empty:** no rows at all is `<Empty>` in place of the table; a search that missed is a
  `TableEmpty` row under the header.
- **Phones:** `stack="cards"` turns each row into a card, the first cell on its own line and the
  rest named by their `label`; `stack="rows"` leaves the row's layout to the caller (the orders and
  carts lists, where the whole card opens the row). Either way the header stays for screen readers
  and the parts keep their table roles.
- **Long lists** (`sticky`) keep the header under the shell's header; the card clips with
  `overflow-clip`, never `overflow-hidden`, which would stop it.

## Screens that change shape

- **Flow editor:** at lg it builds. On touch, a palette item is tapped in (dragging is unreliable
  on iPadOS), node handles grow and carry a 32px target, and a connection snaps from 40px. Below lg
  it is review-only, saying so: nothing on screen can change the flow. A Loop's second input,
  `next`, is a hollow ink ring on the node's bottom edge, named under the outputs, and its back-edge
  is dashed ink labelled `next`: colour on the canvas is for status only (The One Meaning Rule).
  A flow too wide to read whole opens framed on its first loop or wait (an order page frames its
  live, failed or final step instead), never below 0.7 zoom. Fit view stops at the zoom that keeps
  a 13px label at 10px and, past that, fits around the selection or the current view. Every
  canvas with a loop or a wait has **Jump to**, a menu of them by label that centres the one
  picked; it is on the canvas, so it works in the review-only editor and the order page's Graph
  tab. React Flow's credit stays (its authors ask that only subscribers remove it), at caption
  size.
- **Overview** (`routes/dashboard.tsx`), composed from shadcn's preview-02 cards: open work as two
  figure cards (label at the top, the count at the foot; the whole card opens those orders), the
  last day's endings as one card of five figures, then cards with a header (title, a one-line
  description, an outline action) over Items: decisions as muted Items, waiting steps as muted
  Item chips along each flow, endings and recent orders as quiet Item rows, and an Empty with an
  icon when there are no orders. On a phone "Needs a decision" (or "No decisions waiting") comes
  first, above the figures (the two grids below md are `contents`, and that card is ordered
  first); the endings are one line, label then count, 44px tall, scrolling sideways if it doesn't
  fit.
- **Orders list on a phone:** the bar keeps the search and a Filter button with the count of
  filters set; model, channel, status, sort and Needs attention move to a bottom sheet. They are the
  same URL parameters as the bar's from md.
- **Order page:** its panels are cards: Actions leads with what waits (muted Items with their
  controls) before the rollback; Activity is a Timeline card of quiet Items; Details keeps its
  record tables in flush cards. At lg the graph sits beside Actions, Activity, Details and Node. Below lg the
  graph is a tab of its own, so each view has the screen and the page is the one scroll region.
  Its header's title wraps; the totals ("N lines · tax") stay on one line and, with Ask and Share,
  wrap below the title as a group. Below md Cancel order moves into a ghost `⋯` menu ("More order
  actions") at the group's end, opening the same Cancel panel under the header.
- **Tables:** below md, `table-stack` makes each row a card: its first cell on a line of its own,
  the others wrapping beneath it, each named by its `data-label`. A table that already fits keeps
  its rows.
- **Catalog board** (`routes/catalog.tsx`): at lg, four column cards side by side in a grid
  (`minmax(0,1.5fr)` then three `minmax(0,1fr)`), Gaps widest on the left. Below lg the columns
  become a segmented control (each label with its count; Published today reads "Today"), one
  column shows at a time, and its header is visually hidden but stays for screen readers. Below lg
  the board reviews and accepts drafts only; drafting from a card, ticking and publishing are for
  lg, said in place.

## Elevation & Depth

Flat. A card sits on the page edged by a faint ring and no shadow; inside it, depth is tonal:
tiles are a muted step. Shadows are kept for what floats over the page (menus, sheets, a phone's
New order).

### Shadow Vocabulary
- **Card** (`box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 10%, transparent)`): every panel (`card`), a ring rather than a shadow.
- **Raised segment** (`shadow-sm`): the chosen segment of a segmented control.
- **Float** (`shadow-float`): a control over a scrolling page, a phone's New order. None in dark.
- **Overlay** (`shadow-overlay`): the sidebar opened over the page (`peek`). Deeper in dark, where it
  still has to lift off a near-black page.

### Named Rules
**The No Nested Cards Rule.** Inside a card, group with tiles or rows, never another card.

## Motion

Quiet and exact. The console is watched all day, so things move only when state changes, and only
to say what changed and where: opacity, colour and a few pixels of travel. Nothing bounces, scales
content or loops, except live work (a running step's pulse, a live edge's dash, the ellipsis and
shimmer of work in progress, the slow-page bar).

### Tokens

In `app.css`, and in `app/lib/motion.ts` for animations run from script (a test keeps them equal).

- **Durations:** `--motion-instant` 100ms (feedback, hover, anything leaving), `--motion-move` 180ms
  (something appearing or changing state), `--motion-travel` 240ms (pages and panels). Plain
  `transition-*` utilities default to instant.
- **Easing:** `ease-arrive` (`cubic-bezier(0.16,1,0.3,1)`) for arrivals; `ease-leave` for exits,
  which are also shorter.
- **Arrival:** `animate-arrive`, a fade and a 4px rise in move time, for something new in a list
  or a log.

### Moments

- **A step settling.** When a step changes state, its status rule and its edges on the order's
  graph, its badges and dots cross-fade to the new status colour in move time, and the timeline
  entry that reports it arrives on top with `animate-arrive`. Graph and timeline move together, so
  the eye joins them.
- **Deciding.** The undo notice arrives with `animate-arrive`, and a hairline along its foot drains
  over exactly that decision's window (shorter near a deadline). "Recording decision…" arrives the
  same way.
- **Moving between pages.** Shell links, the orders list and an order's breadcrumb use View
  Transitions: the page cross-fades (the old page leaves in instant time, the new arrives in
  travel time) while the top bar and the tab bar hold still. From md, an order's title travels
  from its row to the order page's heading and back; on a phone the page only cross-fades.
- **Lists that change.** Orders and approvals that join an open list fade in (`useArrivals`): never
  what was already on screen, never a whole new list (another filter or page), never more than five
  at once (a burst is a refresh), and never while the tab is hidden, so coming back shows the
  current state at once. An approval that resolves holds its place and fades to the resolved tint.
- **Overlays.** Menus and dialogs open in instant time; sheets open in travel time and close in
  move time, decelerating in and accelerating out.

### Named Rules
**The Reduced Motion Rule.** With reduced motion nothing travels, but nothing that carries meaning
is lost: colours still change, arrivals and overlays (menus, dialogs, sheets) fade without rising,
sliding or zooming, page changes happen at once, and the undo bar is hidden because the seconds
count says the same.

## Shapes

Generous and round. The radius base is 0.625rem on a multiplying scale: cards are 2xl, tiles and
rows inside a card xl, the flow canvas 2xl, one-line fields 4xl, text areas xl, menus 2xl, and
bordered notices, option tiles and bordered lists lg (the preset's alert and item). Buttons, one-line
fields, badges, segmented controls, filter links and icon buttons are pills. Checkboxes are 6px
boxes and radios round, both native and drawn by app.css. Hairlines divide rows inside a card; cards
themselves have no border.

**The Pill Rule.** Anything you press or that labels a status is fully round. Square corners are
for code and data blocks only.

## Components

- **Buttons** (`packages/ui/src/button.tsx`): pills. Primary is an ink fill with paper text; outline is a
  rule over a faint `input` fill; ghost fills muted on hover; link is the work blue. Focus turns the edge to `ring`
  with a soft halo. Every size carries `hit-area`.
- **Fields** (`input.tsx`, `textarea.tsx`, `native-select.tsx`): pills with an `input` hairline
  over an `input` fill at 30%. Focus: the `ring` edge and halo. Invalid: the destructive edge.
- **Segmented** (`segmented.tsx`): a radio group drawn as a muted pill track; the chosen segment
  is raised on paper. Arrow keys move the choice.
- **Card** (`packages/ui/src/card.tsx`, radix-maia): `Card` (rounded 2xl, a 10% ring; `size="sm"`
  for 16px spacing), `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`,
  `CardFooter`. `Section` (`components/page.tsx`) is a Card at 20px spacing with a section title,
  an optional description and action, and `flush` content under a rule; it clips rather than
  hides, so sticky table headers still stick. The `card` and `tile` utilities in app.css remain
  for the few panels that aren't sections.
- **Composition** (every page, from shadcn's preview-02 cards): a page is cards with a header
  (title, a one-line description of what the card already does, an outline action) over Items,
  Fields or a table. Tables stay where people compare columns (orders, records, prices, the audit
  log); rows read one at a time are Items (approvals, carts, people, tokens, plugins, sessions,
  files). Forms are `FieldGroup`/`Field`/`FieldLabel` with hints as `FieldDescription` tied by
  `aria-describedby`. Settings pages are one column of settings cards with reference material
  (roles, install from a file) in a rail at lg, last on phones. Sign-in, setup, two-factor, the
  single-sign-on link and OAuth consent are one centred Card.
- **Item** (`item.tsx`, radix-maia): a row with media, content (title, description) and actions;
  `default`, `outline` and `muted`, in `default`, `sm` and `xs`. A list of Items is a `<ul>` of
  `Item asChild` `<li>`s (ItemGroup carries no list role). A row that opens something links its
  title and stretches the link over the Item.
- **Empty** (`components/page.tsx` over `empty.tsx`): the description and an optional action;
  with an `icon` and a `title` where the empty state is the news (no orders yet).
- **Badge, Skeleton, Separator, Kbd, Spinner, Field, Label, Breadcrumb** (`packages/ui/src`):
  radix-maia, ported unchanged but for Lucide icons in place of shadcn's icon placeholder, a
  BreadcrumbPage that is `aria-current` only (not a disabled link), and an ItemGroup with no list
  role.
- **Status badge** (`components/status.tsx`): Maia's Badge, tinted 11% in the status colour; an ending
  that went badly is ruled in the colour with a mark (✕ or undo) instead of tinted, so it reads
  apart without colour.
- **Counts** (pending approvals in the bars): `wait` pills.
- **Sidebar** (`packages/ui/src/sidebar.tsx`): shadcn's, adapted; see The shell.
- **Tooltip** (`packages/ui/src/tooltip.tsx`): an ink pill with paper text, 12px, after 300ms; only
  where a name isn't on screen (the sidebar's rail).
- **Confirm** (`components/confirm.tsx`): an "are you sure?" where the action was, never a modal.
  The safe choice has focus, Escape backs out of the newest one, and focus goes back to what
  asked. Its actions are children, so it sits inside the caller's form.
- **Sheet** (`packages/ui/src/sheet.tsx`): from the bottom on a phone, capped at 85dvh and scrolling
  inside, with its corners rounded at the top; from the side otherwise. It pads for the safe areas.
- **Form sheet** (`components/form-sheet.tsx`): a list page's create form behind one primary
  "New …" button (a `Plus` and the noun) in the page or section header, opened in a Sheet 28rem
  wide. The form mounts only while open, so closing clears it; a refusal keeps it open with the
  error under the fields; success closes it (or the page moves on). Never a create form left open
  under a list.
- **Row actions** (Team's people): a row's secondary actions in one ghost `⋯` menu at its end,
  labelled "Actions for <name>", so every row has the same shape. Items that can't be taken back end
  in "…" and open a Confirm under the row; the destructive one sits below a separator. On a phone
  the menu sits in the row's top corner. Save beside a row's field shows only once it changes.
- **Share** (`components/share-button.tsx`): the system share sheet where there is one, else Copy
  link.
- **Board column** (`ColumnShell` in `routes/catalog.tsx`): a `Card size="sm"` per state in a
  labelled region, its header a section title, a 0.5rem status dot before it (`wait` for Gaps, `ai`
  for Drafted, an ink ring at 60% for Staged, which is not a status, `ok` for Published today), the
  count as a secondary Badge and a one-line description of what the column holds. A column's one
  action is its `CardAction` (Publish heads Staged). Gaps groups its
  products into collapsible sections, each headed by a caption button (a chevron that turns 90°,
  the group's name and `· count`); each product appears in one group only. Longer lists end in a
  link-blue "Show more".
- **Board card** (`CardRow`): an `Item size="xs"` inside a column card, never a card of its own:
  rounded 2xl, muted at 60% on hover and when its link has focus (with a `ring` at 50%). The title (500, body
  size) is the link, stretched over the whole row; the product key is mono 2xs muted under it, then
  a muted reason line clamped to two lines, locales in mono. Its actions sit at the right, above the
  link: a ghost Draft (with the `ai` dot) that shows on hover or focus (always on touch), an outline
  Accept; Staged rows lead with a checkbox ticked for publishing. A row that didn't publish turns its
  reason `bad`. Keyboard: J and K (or the arrows, once a card has focus) move between cards, Enter
  opens one, D drafts, A accepts, X ticks, ⌘Enter (Ctrl+Enter) publishes what's ticked; each is also
  a button, and the hints show only with `fine:` at lg. Cards glide to their new place after a
  change (measured before and after, moved with the Web Animations API in move time on
  `ease-arrive`); reduced motion moves them at once.
- **Product sheet** (`components/catalog/sheet.tsx`): the side sheet from sm, 42rem wide and 56rem
  from xl; below sm the bottom sheet. Its content is a flush `Table`: fields as rows, locales as
  columns (mono, not uppercase, the most-filled first), the field-name column sticky on the left
  with the card's background; the strip scrolls sideways. Below sm each field lists its locales
  stacked, a mono locale beside each value. The field that put the product on the board is tinted
  muted at 60% with a `ring` at 40%, scrolled into view and its first action focused. Each group
  (Refused, Status, Content, From the feed, Published changes) is a `Card size="sm"` in a labelled
  region, titled in `CardTitle`; the Content table runs flush inside its card.
- **Source marker** (in the sheet): every value is labelled 2xs/500 muted, with a 0.375rem dot where
  it isn't plain feed data: From feed (no dot), Edited here and Staged (ink), Draft (`ai`), Draft
  with its field changed since, Conflict and Missing (`wait`), Didn't publish (`bad`). A field with
  no value and no gap is a muted dash, "Empty" to screen readers.
- **Approvals inbox** (`routes/approvals.tsx`): pending approvals are grouped by flow · step · rule
  (`groupApprovals` in `lib/approvals.ts`), one Card per group in a labelled region (its batch
  controls the `CardAction`), each pending row a muted Item, headed by a section title naming all
  three, then a muted line with the count, when the first closes and any order title every row
  shares. Rows say only what differs: the deadline first (`DecisionDeadline`: muted "Decide in 3m"
  or "Closes 2:05 PM", ink in the last ten seconds, never `wait`), the ref (mono), the customer and
  the age, with the row's reason on one truncated line only when it adds to the group's rule, and a
  Details disclosure (a chevron that turns 90°) for the figures, trail, timeout step, assignee and
  the note field. A group with two or more rows the person can decide leads each with a checkbox
  (`accent-foreground`, `hit-area`) and its header with Select all; ticking shows Approve selected
  (ink) and Reject selected (outline) at the header's right. A batch is each row's own held
  decision (`DecisionHandle`), so each row shows its own Undo; the header shows the count and
  seconds left with Undo all, which takes focus. A row that can't be ticked keeps the column empty
  and says why in place of its buttons. X (or Space on the row) ticks; Z with Undo all focused
  takes the batch back; one polite live line per group speaks when a batch starts and ends. A row
  whose decisions have closed leaves its group for a folded muted line under the list ("2
  approvals closed, waiting for the engine"), never disabled buttons. Motion follows the shared rules: a row
  that joins while the inbox is open fades in (`animate-arrive`, `useArrivals`), a group that forms
  fades in as one (its rows don't fade again), and a row that resolves holds its place and fades to
  the resolved tint.
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
- **Do** take durations and easing from the motion tokens, and animate only what is new
  (`useArrivals`), never a list as it first draws.

### Don't

- **Don't** fade the focus ring below 3:1, or remove the outline without drawing an edge.
- **Don't** put a status colour on something that isn't a status.
- **Don't** read `env(safe-area-inset-*)` directly, or hard-code 3rem for the header or 16rem for the
  sidebar (`--shell-h`, `--sidebar-width`).
- **Don't** set a field under 16px for touch, or show a keyboard shortcut to a finger.
- **Don't** let a narrow screen change what it can't save (the flow editor below lg).
- **Don't** interrupt work to suggest installing the app.
- **Don't** port another product's look; Ledger is this product's.
- **Don't** make a person wait on motion: an action responds at once, and a page change never
  waits for its transition.
