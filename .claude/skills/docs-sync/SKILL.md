---
name: docs-sync
description: Keep the Starlight docs in apps/docs true to Order Loop's code after a change. Use when a change touches a documented surface (node catalog, planner, Workflow, OrderAgent, REST API, webhooks, D1 schema, wrangler config, Ledger tokens), when the docs-drift hook fires, or when docs look stale. Maps changed files to pages, separates generated reference pages from hand-written prose, and verifies with the docs build.
license: MIT
metadata:
  repo: orderloop
---

# Syncing the docs

The docs are `apps/docs` (`@orderloop/docs`): Starlight on Astro, static output, served by the
`orderloop-docs` static-assets Worker at `docs.orderloop.io`. They document Order Loop as it is at
this commit, for operators (Start, Guides, Reference) and contributors (Internals).

## What syncs itself, and what doesn't

**Generated at build time. Never hand-copy these into prose:**

| Output | Source | Component |
|---|---|---|
| Node catalog (`reference/nodes`) | `NODE_SPECS`, `packages/core/src/catalog.ts` | `NodeCatalog.astro` |
| Built-in flows (`guides/templates`) | `TEMPLATES`, `packages/core/src/templates.ts` | `Templates.astro` |
| Node → event table | `NODE_EVENTS`, `packages/core/src/webhooks.ts` | `NodeEvents.astro` |
| Enum lists (statuses, order types, events, policy rules) | `packages/core/src/{types,webhooks,policy}.ts` | `Values.astro` |
| `/openapi.json` and the `/api/` explorer | `apps/web/app/lib/openapi.ts` + `api-schemas.ts` | `src/pages/openapi.json.ts` |

Rebuilding refreshes these. But the prose *around* them still makes claims (a node's behaviour, a
branch name used in an example, a default quoted in a sentence), and those are yours to check.

**Hand-written, so they drift:** everything else in `src/content/`, plus `src/styles/ledger.css`
and `src/pages/api.astro`, which mirror the Ledger tokens in `apps/web/app/app.css` by value.

## Procedure

1. **Scope.** Use the files named in the request. Otherwise take
   `git diff --name-only main...HEAD` plus uncommitted changes (`git status --porcelain`).
2. **Map files to pages** with [references/surface-map.tsv](references/surface-map.tsv), the same
   table the hooks use. A changed file with no row is probably undocumented; say so rather than
   guessing a page. If it is a documented surface the map misses, add a row.
3. **Read the diff, then the page.** For each page, find every sentence the change could falsify:
   names, defaults, branch names, status codes, step names, table columns, examples. Grep the docs
   for the old identifier: `grep -rn '<old name>' apps/docs/src`.
4. **Verify against source, not memory.** Every identifier, default, route and status code you
   write must be grepped from the code at this commit. Nothing type-checks prose.
5. **Edit surgically** in the existing voice (see the `docs-page` skill): dense, factual, present
   tense, identifiers in backticks, sentence-case headings, no marketing prose. Prefer one changed
   sentence over a rewritten section. If you would restate an enum, use `Values.astro` instead.
6. **New page?** Follow the `docs-page` skill. It is invisible until it is in `sidebar` in
   `apps/docs/astro.config.mjs`.
7. **Ledger tokens.** If `apps/web/app/app.css` changed a colour or font, change the same value in
   `apps/docs/src/styles/ledger.css` and, for the explorer, `apps/docs/src/pages/api.astro`.
8. **Repo-level docs.** `README.md`, `CLAUDE.md` and `ROADMAP.md` describe the same system; if the
   change falsifies them, fix them too (a shipped roadmap item moves out of the roadmap).
9. **Build:** `pnpm docs:build`. It fails on bad frontmatter, an unknown sidebar slug, an MDX
   syntax error, a broken import from `@orderloop/core`, and (via `scripts/check-links.mjs`) any
   internal link or `#anchor` that doesn't resolve. It does not catch a wrong claim.

## Things that bite

- Prose is at `src/content/`, not `src/content/docs/`; `content.config.ts` uses a `glob` loader.
  Don't move files to "fix" it.
- MDX treats `{` and `<` as code. Write `{{path}}` templates and `<id>` placeholders inside
  backticks or code blocks.
- Node catalog anchors are node types (`/reference/nodes/#commerce.policy`). Renaming a node type
  breaks links; the link check will name them.
- Step names (`${nodeId}#${run}`) are durable identifiers. If a change renames them, that is a
  code problem to raise, not a docs edit (CLAUDE.md).
- The live site only changes on `pnpm docs:deploy`. Deploying is a human decision; never run it
  unprompted.

## Report

List each drift as `source → page`: what was stale and what it says now. Then the files edited,
the build result (paste failures verbatim), and anything you deliberately left alone or could not
verify, flagged for a human.
