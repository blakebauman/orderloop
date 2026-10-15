---
name: docs-page
description: Add or restructure a page in the Order Loop docs (the apps/docs site, or the unpublished maintainer docs in docs/). Use when a new feature, node family or API surface needs its own page, or when a page should split or move. Covers where the page goes, frontmatter, sidebar registration, the generated components, the writing voice and the checks.
license: MIT
metadata:
  repo: orderloop
---

# Adding a docs page

## Who it is for

The published site is for two readers: people who use a workspace at `orderloop.app` (build flows,
run orders, decide approvals, manage the team) and developers who integrate another system with one
(REST API, signed webhooks, channel adapters, email intake, MCP, A2A). It is not for people who
deploy, configure or develop OrderLoop.

Material only someone with the source or a Cloudflare account needs goes in the repo-root `docs/`
folder instead: plain Markdown, not published, indexed by `docs/README.md`. That covers source
paths and function names, bindings, env vars and secrets, `wrangler`, D1 tables, R2 keys, Workflow
and Durable Object mechanics, deploys, CI and local development. On the site, describe a deployment
setting by what it does and say the workspace administrator sets it (for example "the workspace's
signing secret"), never by its variable name.

## Where it goes

| Section | Directory | For |
|---|---|---|
| Start | `src/content/start/` | Reading in order: getting started, concepts |
| Guides | `src/content/guides/` | A task or a feature, end to end |
| Reference | `src/content/reference/` | Things you look up: routes, nodes, fields, expressions |
| Maintainer docs | `docs/` (repo root) | How it is built, configured, deployed and tested; name the source files |

A maintainer page is a `docs/<slug>.md` with an `#` title and a one-line summary under it, a row in
`docs/README.md`, and relative links between maintainer pages; it links site pages as
`https://docs.orderloop.app/…/`. Site pages never link into `docs/`.

Before adding a page, check whether the content belongs as a section of an existing one. A new
page earns its place when it has its own reader and its own question.

## Steps

For a site page:

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
- Identifiers, routes and values in backticks. On the site, name routes, fields, headers and
  values a reader can see or send, not source files; in `docs/`, paths are repo-relative.
- Sentence-case headings. No marketing words ("powerful", "seamless", "simply").
- Say what happens and why, then stop. A table beats a paragraph listing five fields.
- Examples are real: ids from the seeded data (`cus_ada`, `tpl-storefront-order`, `MON-27`, `cus_northwind`, `tpl-b2b-order`, `WID-100`), across more than one commerce model, real
  node ids from the built-in flows, routes that exist.
- Styling follows `apps/docs/DESIGN.md`. Colours come from the generated `src/styles/theme.css`
  (never hand-edited); hand-written rules go in `src/styles/brand.css`. Draw Order Loop concepts
  with the existing components (node cards, status stamps) rather than new ad-hoc markup. Don't add
  per-page CSS, and don't borrow styles from other projects.
