# CLAUDE.md

Order Loop is an agent loop for the commerce order lifecycle on Cloudflare. It's a pnpm + Turborepo + Biome monorepo; read README.md for the architecture.

## Commands

```bash
pnpm install
pnpm web:dev                 # web + engine together (engine is a Vite auxiliary Worker)
pnpm test                    # turbo → vitest (core in node, engine and catalog e2e in workerd, web in node)
pnpm lint                    # turbo → biome check
pnpm check-types             # turbo → tsc --noEmit (web runs react-router typegen first)
pnpm test:fleet              # deployments/ registry and the configs scripts/fleet.ts renders
pnpm test:toolkit            # .claude/ toolkit: skill/agent lint and hook tests (see .claude/README.md)
pnpm --filter @orderloop/<pkg> test     # one package's tests
pnpm turbo run lint check-types test --filter='...[origin/main]'  # what changed since main, plus dependents
pnpm --filter @orderloop/engine types   # after changing apps/engine/wrangler.jsonc
pnpm --filter @orderloop/web types      # after changing apps/web/wrangler.jsonc
pnpm --filter @orderloop/catalog types  # after changing apps/catalog/wrangler.jsonc
pnpm --filter @orderloop/catalog-edge types  # after changing apps/catalog-edge/wrangler.jsonc
pnpm plugin:check <deployment> <plugin>      # before removing a plugin (needs ORDERLOOP_API_TOKEN)
pnpm docs:dev / docs:build              # Starlight docs in apps/docs (build includes a link check)
pnpm sync:theme                         # regenerate the docs theme from packages/design tokens
```

## Rules

- Never use a trailing "z" in endpoint names (`/health`, not `/healthz`).
- Production deploys from CI: merging to `main` runs `.github/workflows/ci.yml` (migrate D1, catalog, catalog-edge, engine, web, docs). Don't deploy or run remote migrations by hand; if the deploy job fails, re-run its failed jobs.
- `packages/core` has no bindings and no Cloudflare imports. Anything that needs `env` belongs in an app.
- Planner semantics (readiness, skips, loops) live only in `packages/core/src/graph.ts` and are unit tested there. The Workflow adds durability; it must not re-implement scheduling.
- Workflow determinism: every effect happens inside a `step.do`, and anything that touches time or a model also goes in a step. Nodes are applied in graph order after each batch. Step names are `${nodeId}#${run}`; never rename them in a way that would change a published flow's names.
- Reports from the Workflow to the OrderAgent are either sequenced plan snapshots (non-durable; the agent drops stale ones) or detail reports sent from inside steps. Keep agent updates idempotent.
- Every connector write is keyed by its step key, and every compensation is idempotent. A node type with `rollback: true` in the catalog must have an entry in `ROLLBACKS` (`apps/engine/src/nodes.ts`).
- Adding a node type: add it to the catalog (`packages/core/src/catalog.ts`), add an executor (or interpreter case), and add its icon to `apps/web/app/components/node-icon.tsx`.
- `packages/db/src/schema.ts` must match `packages/db/migrations/*.sql`. Add a new numbered migration; never edit an applied one. CI applies migrations before it deploys the Workers, and a failed smoke test rolls the Workers back but not D1, so a migration must work with the code already deployed: add first (expand), and drop or rename only in a later change once nothing deployed uses it (contract).
- The web app talks to the engine only through `EngineRpc` (`packages/core/src/api.ts`) the proxied `/agents/order-agent/:id` and `/agents/assistant-agent/*` sockets, and `/mcp` and `/a2a`, which it forwards after resolving the caller (`apps/web/app/lib/oauth.server.ts`), and `/ucp/*`, which it forwards after resolving the UCP platform (`apps/web/app/lib/ucp.server.ts`). The engine trusts the principal header on all of them only when it is signed with `PRINCIPAL_KEY` for that path and unexpired (`signPrincipal` and `verifyPrincipal` in `packages/core/src/roles.ts`); credentials never reach it. A UCP platform is signed as its own envelope (`signPlatform` / `verifyPlatform`) that no other route accepts, and acts only on the checkouts and orders it started. Each of `/mcp` and `/a2a` is its own OAuth resource: a token works only at the endpoint it was granted for. The web app never imports engine source.
- Agentic checkout (UCP, `apps/engine/src/ucp/`) prices a session with the checkout flow's own pricing nodes (`quoteNodes` in `packages/core/src/checkout.ts`), so the PaymentIntent it holds at completion is the amount the flow's authorize node adopts. Don't price checkouts any other way. What it serves is tested against UCP's published schemas (`packages/core/tests/fixtures/ucp`, vendored unchanged).
- Visual design is "Ledger" (tokens in `apps/web/app/app.css`). Don't reuse styling from other projects. `packages/design/src/tokens.ts` mirrors those tokens (its tests fail if they differ) and generates the docs theme: after changing a token in `app.css`, change it there and run `pnpm sync:theme`. The docs' design is recorded in `apps/docs/DESIGN.md`.
- The product catalog (`apps/catalog`, model in `packages/core/src/product/`): the shard hash and counts (`routing.ts`) are frozen by golden tests, since changing them strands every stored product; never update those expected values. Product types change only by a new, additive version (`typeChangeIssues`). A change to a published document's shape bumps `DOC_FORMAT` and needs a reindex. A write lands in the shard's transaction with its outbox row and publishes from the alarm; never publish outside the outbox. Shards never await another shard while holding a transaction or `blockConcurrencyWhile` (two shards claiming aliases from each other would deadlock). Callers type the catalog binding as `ProductCatalogRpc`, as the web app does with `EngineRpc`; a new catalog resource goes in `scripts/fleet.ts` and `scripts/provision.sh` so every deployment gets its own. `apps/catalog-edge` is read-only and serves only what the publisher wrote; it imports core only through the zod-free subpaths `@orderloop/core/product/paths`, `@orderloop/core/product/listing` and `@orderloop/core/product/search` (types may come from `@orderloop/core/product`), so its bundle stays ~10 KiB gzipped, and every request reaches its cached `Delivery` entrypoint by its canonical URL (`routes.ts`). Purges are rationed (Workers Caching uses Free-plan limits): freshness comes from `max-age` and ETag revalidation, and only urgent writes queue a purge.
- Plugins (`plugins/<id>/`, contract in `packages/core/src/plugins.ts`, see `docs/plugins.md`) are optional Workers a deployment installs through its registry's `plugins`, bound as `PLUGIN_<ID>`. A plugin imports only `@orderloop/core`, `@orderloop/design` and `@orderloop/plugin-sdk`, is built with `definePlugin` and passes `pluginContract` in its own tests, gets buyer details only if its manifest sets `personalData: 'send'`, owns its own D1 database and migrations (the core schema never holds a plugin's tables), namespaces its node types `<id>.<name>`, and keys every write and compensation by order id + step key and every delivery by its payload id. The core never imports plugin code and must keep working with no plugin bound: the engine's default test project runs without one. `plugins/example` is a test fixture that no deployment may install.
- vitest is pinned to 5.0.3: 5.0.4's module cache breaks `@cloudflare/vitest-plugin`.
- Docs: `apps/docs` (Starlight, published) is for workspace users and integrators; how OrderLoop is built, configured, deployed and tested lives in `docs/` (Markdown, unpublished). Keep source paths, env vars, bindings and `wrangler` out of the site. When a change touches a documented surface, update the docs in the same change: follow the `docs-sync` skill or delegate to the `docs-sync` agent. The source→page map is `.claude/skills/docs-sync/references/surface-map.tsv`. Reference pages render from `@orderloop/core` at build time; never hand-copy catalog data or enums into MDX. The docs import only `@orderloop/core` and `apps/web/app/lib/openapi.ts`, never engine source.
- `@callable()` uses TC39 decorators; `apps/web/vite.config.ts` and `apps/engine/vitest.config.ts` include `agents/vite` so they are transformed (the engine has no Vite config of its own; in dev it runs inside the web app's Vite session).
