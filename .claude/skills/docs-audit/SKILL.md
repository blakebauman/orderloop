---
name: docs-audit
description: Full audit of the Order Loop docs against the code, page by page. Use for a periodic sweep, before a release, or when many changes have landed without doc updates. Slower and broader than docs-sync, which follows a diff; this reads every page and checks every claim.
license: MIT
disable-model-invocation: true
metadata:
  repo: orderloop
---

# Auditing the docs

Run this deliberately (`/docs-audit`); it reads the whole docs tree and a lot of source. For a
single change, use `docs-sync` instead. To keep your context small, delegate to the `docs-sync`
agent, one section per agent: Start, Guides, Reference, Internals.

## Procedure

1. **Build first:** `pnpm docs:build`. Fix anything it reports before reading prose.
2. **For each page in `apps/docs/src/content/`** (all of them, including `index.mdx`):
   - List its checkable claims: identifiers, defaults, routes and status codes, branch names, step
     names, table columns, file paths, commands, numbers (timeouts, retries, limits).
   - Grep each one in the source. Mark it confirmed, wrong (and fix it) or unverifiable (flag it).
   - Check that commands in code blocks still exist in `package.json` scripts.
3. **Coverage, the other direction.** Walk the source surfaces in
   `.claude/skills/docs-sync/references/surface-map.tsv` and ask what a reader would need that no
   page says: a new route in `apps/web/app/lib/api.server.ts`, a new `vars` entry in
   `apps/engine/src/nodes.ts`, a new table in `packages/db/src/schema.ts`, a new binding or var in a
   `wrangler.jsonc`. Also check for source files that should be in the map but aren't.
4. **Repo docs.** Compare `README.md`, `CLAUDE.md` and `ROADMAP.md` with the docs; they must not
   disagree. A roadmap item that has shipped is a doc change in two places.
5. **Styling.** Diff the colour and font values in `apps/docs/src/styles/brand.css` (hand-written)
   and the generated `theme.css` against `apps/web/app/app.css`; record what changed in
   `apps/docs/DESIGN.md`.
6. **Build again.**

## Report

A table per section: page, claims checked, fixed, flagged. Then the coverage gaps, the files
edited, the final build result, and the list of code-side discrepancies you found but did not fix
(a docs audit doesn't change runtime code).
