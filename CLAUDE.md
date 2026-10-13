# CLAUDE.md

Order Loop is an agent loop for the commerce order lifecycle on Cloudflare. It's a pnpm + Turborepo + Biome monorepo; read README.md for the architecture.

## Commands

```bash
pnpm install
pnpm web:dev                 # web + engine together (engine is a Vite auxiliary Worker)
pnpm test                    # turbo → vitest (core in node, engine e2e in workerd, web in node)
pnpm lint                    # turbo → biome check
pnpm check-types             # turbo → tsc --noEmit (web runs react-router typegen first)
pnpm --filter @orderloop/engine types   # after changing apps/engine/wrangler.jsonc
pnpm --filter @orderloop/web types      # after changing apps/web/wrangler.jsonc
pnpm docs:dev / docs:build              # Starlight docs in apps/docs (build includes a link check)
```

## Rules

- Never use a trailing "z" in endpoint names (`/health`, not `/healthz`).
- `packages/core` has no bindings and no Cloudflare imports. Anything that needs `env` belongs in an app.
- Planner semantics (readiness, skips, loops) live only in `packages/core/src/graph.ts` and are unit tested there. The Workflow adds durability; it must not re-implement scheduling.
- Workflow determinism: every effect happens inside a `step.do`, and anything that touches time or a model also goes in a step. Nodes are applied in graph order after each batch. Step names are `${nodeId}#${run}`; never rename them in a way that would change a published flow's names.
- Reports from the Workflow to the OrderAgent are either sequenced plan snapshots (non-durable; the agent drops stale ones) or detail reports sent from inside steps. Keep agent updates idempotent.
- Every connector write is keyed by its step key, and every compensation is idempotent. A node type with `rollback: true` in the catalog must have an entry in `ROLLBACKS` (`apps/engine/src/nodes.ts`).
- Adding a node type: add it to the catalog (`packages/core/src/catalog.ts`), add an executor (or interpreter case), and add its icon to `apps/web/app/components/node-icon.tsx`.
- `packages/db/src/schema.ts` must match `packages/db/migrations/*.sql`. Add a new numbered migration; never edit an applied one.
- The web app talks to the engine only through `EngineRpc` (`packages/core/src/api.ts`) and the proxied `/agents/order-agent/:id` socket. It never imports engine source.
- Visual design is "Ledger" (tokens in `apps/web/app/app.css`). Don't reuse styling from other projects.
- vitest is pinned to 5.0.3: 5.0.4's module cache breaks `@cloudflare/vitest-plugin`.
- Docs live in `apps/docs` (Starlight). When a change touches a documented surface, update the docs in the same change: follow the `docs-sync` skill or delegate to the `docs-sync` agent. The source→page map is `.claude/skills/docs-sync/references/surface-map.tsv`. Reference pages render from `@orderloop/core` at build time; never hand-copy catalog data or enums into MDX. The docs import only `@orderloop/core` and `apps/web/app/lib/openapi.ts`, never engine source.
- `@callable()` uses TC39 decorators; `apps/web/vite.config.ts` and `apps/engine/vitest.config.ts` include `agents/vite` so they are transformed (the engine has no Vite config of its own; in dev it runs inside the web app's Vite session).
