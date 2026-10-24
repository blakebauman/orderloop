---
name: d1-migration
description: Add a D1 schema change to Order Loop safely. Picks the next migration number, writes an expand-only migration that works with the code already deployed, mirrors it in the Drizzle schema, applies it locally and tests it. Use for any new table, column, index or data backfill in packages/db (or a plugin's own migrations), and when planning a rename or drop as expand-then-contract.
license: MIT
argument-hint: "[short_snake_name]"
metadata:
  repo: orderloop
---

# Adding a D1 migration

The core database's migrations are `packages/db/migrations/NNNN_name.sql`; the Drizzle schema is
`packages/db/src/schema.ts` and must match them column for column and index for index. A plugin
has its own database and migrations under `plugins/<id>/migrations/`; the core schema never holds a
plugin's tables.

## Why it's careful

CI's deploy job (`.github/workflows/deploy.yml`) records a D1 bookmark, applies migrations, *then*
deploys the Workers, and on a failed smoke test rolls the Workers back but **not** D1. So every
migration runs against the code already deployed, for at least the length of a deploy and
possibly indefinitely. An applied migration (anything on `origin/main`) is never edited; the
`guard-invariants` hook denies it.

## Steps

1. **Number.** `ls packages/db/migrations | tail -1`, then the next four-digit number. Name it
   `$ARGUMENTS` or a short snake_case description: `0044_order_tags.sql`. If another open PR
   already took the number, the later one renumbers before merge.
2. **Write it expand-only.** Start with a `--` comment saying what it's for and what's null or
   defaulted for existing rows (see `0042_flow_archived.sql`). Allowed now:
   - `CREATE TABLE`, `CREATE INDEX` (`IF NOT EXISTS` where a re-run is possible);
   - `ALTER TABLE … ADD COLUMN` that is nullable or has a constant default;
   - backfills (`UPDATE`) that old code tolerates.
   Not in the same change as the code that stops using it: `DROP TABLE`, `DROP COLUMN`,
   `RENAME`, a `NOT NULL` column without a default, a tightened `CHECK`. Those are a **contract**
   step: a later PR, after a deploy where nothing reads or writes the old shape.
3. **Mirror it** in `packages/db/src/schema.ts` (same names, types, defaults, indexes).
4. **Apply locally.** `pnpm db:migrate:local`; if you need demo data, `pnpm db:seed:local`.
   Never `--remote` or `db:migrate:remote`; the `guard-bash` hook denies both.
5. **Test.**
   - The engine suite applies every migration to its test D1 (`apps/engine/tests/setup.ts`), so
     `pnpm --filter @orderloop/engine test` proves it applies cleanly after the others.
   - A migration that moves or reshapes data gets a case in
     `apps/engine/tests/migrations.test.ts`, which applies migrations up to one and runs it
     against rows in the older shape.
   - Seed data lives in `packages/db/seed`, not in migrations; a new required column may need
     the seed updated.
6. **Docs.** `docs/data-model.md` describes the tables; the `docs-impact` hook names it. Update it
   in the same change.

## Rename or drop: expand, then contract

1. PR 1 (expand): add the new column or table; write both; read the new one with a fallback to
   the old; backfill.
2. Deploy it to every ring.
3. PR 2 (contract): stop writing the old one, then drop it in a new migration.

Say in PR 1's description that a contract PR follows, and what it will drop.
