---
name: docs-page
description: Add or restructure a page in the Order Loop docs (apps/docs). Use when a new feature, node family or API surface needs its own page, or when a page should split or move. Covers where the page goes, frontmatter, sidebar registration, the generated components, the writing voice and the checks.
license: MIT
metadata:
  repo: orderloop
---

# Adding a docs page

## Where it goes

| Section | Directory | For |
|---|---|---|
| Start | `src/content/start/` | Reading in order: install, concepts, deploy |
| Guides | `src/content/guides/` | A task or a feature, end to end |
| Reference | `src/content/reference/` | Things you look up: routes, nodes, fields, settings |
| Internals | `src/content/internals/` | How it works, for contributors; name the source files |

Before adding a page, check whether the content belongs as a section of an existing one. A new
page earns its place when it has its own reader and its own question.

## Steps

1. Create `src/content/<section>/<slug>.mdx` with frontmatter:

   ```mdx
   ---
   title: Sentence case title
   description: One sentence saying what the page covers; it is the search snippet.
   ---
   ```

2. Register it in `sidebar` in `apps/docs/astro.config.mjs`, in reading order. Starlight's
   prev/next follows the sidebar. A page that isn't listed builds but can't be found.
3. Add a row to `.claude/skills/docs-sync/references/surface-map.tsv` for the source files the
   page describes, so the hooks and the docs-sync skill know to check it.
4. Link to it from the pages a reader would come from (Concepts, the related guide, the home
   page's cards if it is a main entry point).
5. `pnpm docs:build`, which includes the internal link check.

## Use the source, not a copy of it

Import from `@orderloop/core` rather than restating it:

```mdx
import Values from '../../components/Values.astro';

Order statuses: <Values of="order-statuses" />.
```

`Values` takes `node-statuses`, `order-statuses`, `terminal-order-statuses`, `order-models`,
`order-channels`, `fulfillment-methods`, `outbound-events` or `policy-rules` (add a source in `Values.astro` when you need another).
`NodeCatalog`, `Templates` and `NodeEvents` render the catalog, the built-in flows and the
node-event table. A new component reads `@orderloop/core` only; the docs never import engine
source. The one exception is `src/pages/openapi.json.ts`, which builds the OpenAPI document from
`apps/web/app/lib/openapi.ts`, a file that itself depends only on core and zod.

## Voice

- Dense and factual, present tense, second person where an instruction needs one.
- Identifiers, paths, routes and values in backticks. Paths are repo-relative.
- Sentence-case headings. No marketing words ("powerful", "seamless", "simply").
- Say what happens and why, then stop. A table beats a paragraph listing five fields.
- Examples are real: ids from the seeded data (`cus_northwind`, `tpl-b2b-order`, `WID-100`), real
  node ids from the built-in flows, routes that exist.
- Styling follows `apps/docs/DESIGN.md`. Colours come from the generated `src/styles/theme.css`
  (never hand-edited); hand-written rules go in `src/styles/brand.css`. Draw Order Loop concepts
  with the existing components (node cards, status stamps) rather than new ad-hoc markup. Don't add
  per-page CSS, and don't borrow styles from other projects.
