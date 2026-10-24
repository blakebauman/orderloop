# Invariants: what, why, how to check

Each section: the rule, why it holds, where it lives, and a check you can run from the repo root.
A check that prints nothing passes. Grep the code before quoting a name from here: these notes
describe the code at the time they were written, and the code wins.

## Contents

1. [Workflow determinism](#workflow-determinism)
2. [The planner lives in core](#the-planner-lives-in-core)
3. [Idempotent effects and compensations](#idempotent-effects-and-compensations)
4. [OrderAgent reports](#orderagent-reports)
5. [Package boundaries](#package-boundaries)
6. [Adding a node type](#adding-a-node-type)
7. [D1 schema and migrations](#d1-schema-and-migrations)
8. [Agentic checkout pricing](#agentic-checkout-pricing)
9. [The product catalog](#the-product-catalog)
10. [Plugins](#plugins)
11. [Ledger design tokens](#ledger-design-tokens)
12. [Endpoints, deploys, toolchain](#endpoints-deploys-toolchain)

## Workflow determinism

**Rule.** In `apps/engine/src/workflow.ts`, every effect happens inside a `step.do`, and so does
anything that reads the clock or calls a model. Nodes are applied in graph order after each batch.
Step names are `${nodeId}#${run}` (with `:open`, `:close`, `:until` suffixes for control nodes) and
must never change in a way that renames a published flow's steps.

**Why.** A Workflow replays from the top after every hibernation and retry; completed steps return
their cached result *by name*. Code outside a step runs again on every replay, so an effect there
repeats, and a clock or model read there returns something different and sends the replay down
another branch. A renamed step misses its cache, so a running order re-executes a node it already
finished (a second charge, a second shipment).

**Check.**
- In the diff, every new `await` that does I/O inside `run()` is inside a `step.do` callback.
- `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()` or an AI call outside a step:
  `git diff main...HEAD -- apps/engine/src/workflow.ts | grep -nE '^\+.*(Date\.now|new Date\(|Math\.random|randomUUID|\.run\(|ai\.)'`,
  then read each hit's context.
- Step-name expressions: `grep -n "step.do(" apps/engine/src/workflow.ts`. Any change to the
  template of a name is a breaking change for orders in flight.
- The e2e suite runs real Workflows: `pnpm --filter @orderloop/engine test`.

## The planner lives in core

**Rule.** Readiness, skips, joins and loops are decided only by `packages/core/src/graph.ts`
(`readyNodes`, `beginNode`, …) and unit-tested in `packages/core/tests/graph.test.ts`. The
Workflow adds durability and must not re-implement scheduling.

**Why.** One planner means the editor's validation, the simulator in tests and the running
Workflow agree about which node runs next. A second copy drifts.

**Check.** A diff to `workflow.ts` that decides which node is ready, or skips one, is a finding.
A diff to `graph.ts` comes with a `graph.test.ts` case (use `simulate(graph, choose)`).

## Idempotent effects and compensations

**Rule.** Every connector write is keyed by its step key (`effectKey(generation, stepKey)` in
`workflow.ts`), and every compensation is idempotent. A node type with `rollback: true` in
`packages/core/src/catalog.ts` has an entry in `ROLLBACKS` in `apps/engine/src/nodes.ts`.

**Why.** Steps retry. A write that isn't keyed happens twice when the step fails after the write
and before it returns. A saga runs compensations after partial failure, possibly more than once.

**Check.** `rollback: true` types without a `ROLLBACKS` entry, and the reverse:

```bash
comm -3 \
  <(awk -F"'" "/type: '/{t=\$2} /rollback: true/{print t}" packages/core/src/catalog.ts | sort) \
  <(sed -n '/^export const ROLLBACKS/,/^};/p' apps/engine/src/nodes.ts | grep -oE "^  '[a-z_.]+'" | tr -d " '" | sort)
```

A new external call in `apps/engine/src/connectors.ts` or `payments.ts` passes an idempotency key
derived from the step key (Stripe's `Idempotency-Key` included).

## OrderAgent reports

**Rule.** The Workflow reports to the `OrderAgent` (`apps/engine/src/agent.ts`) either as
sequenced plan snapshots, which are non-durable and dropped when stale, or as detail reports sent
from inside steps. Every agent update is idempotent.

**Why.** Replays resend reports. A non-idempotent update double-counts timeline entries or moves a
terminal order back to running.

**Check.** `apps/engine/tests/agent.test.ts` covers replayed snapshots, deduped timeline keys and
terminal statuses. A new report kind gets a case there.

## Package boundaries

| Rule | Why | Check (prints nothing when kept) |
|---|---|---|
| `packages/core` has no bindings and no Cloudflare imports | It runs in node tests, the browser and the docs build | `grep -rnE "from '(cloudflare:\|@cloudflare/)" packages/core/src` |
| The web app never imports engine source | Separate Workers; the contract is `EngineRpc` (`packages/core/src/api.ts`) | `grep -rnE "from '[^']*(apps/engine\|@orderloop/engine)" apps/web/app` |
| catalog-edge's runtime imports from core are zod-free subpaths (`product/paths`, `product/listing`, `product/search`); `@orderloop/core/product` only as `import type` | Its bundle stays ~10 KiB gzipped (`docs/architecture.md`) | `grep -rnE "^import [^t].*from '@orderloop/core(/product)?'" apps/catalog-edge/src` |
| The core never imports plugin code | A deployment works with no plugin bound | `grep -rnE "from '[^']*plugins/" packages/core/src apps/engine/src apps/web/app` |
| The docs import only `@orderloop/core` and `apps/web/app/lib/openapi.ts` | The site builds without engine source | `grep -rnE "from '[^']*(apps/engine\|@orderloop/engine)" apps/docs/src` |

The web app reaches the engine only through `EngineRpc`, the proxied
`/agents/order-agent/:id` and `/agents/assistant-agent/*` sockets, and `/mcp`, `/a2a` and `/ucp/*`,
which it forwards after resolving the caller. The trust rules for those are in the
`security-model` skill.

## Adding a node type

All of these, in one change (the `add-node-type` skill walks through it):

1. Its spec in `NODE_SPECS`, `packages/core/src/catalog.ts` (type, category, label, description,
   `icon`, fields, outputs, `rollback` if it has a compensation).
2. An executor in `EXECUTORS` (`apps/engine/src/nodes.ts`), or a `case` in the Workflow's
   interpreter for a `control.*` node. Without one, `workflow.ts` throws
   `No executor for <type>`.
3. Its icon imported and mapped in `apps/web/app/components/node-icon.tsx`. Check:
   ```bash
   grep -oE "icon: '[A-Za-z0-9]+'" packages/core/src/catalog.ts | cut -d"'" -f2 | sort -u |
     while read i; do grep -qw "$i" apps/web/app/components/node-icon.tsx || echo "missing $i"; done
   ```
4. A `ROLLBACKS` entry if `rollback: true` (check above).
5. An outbound event in `NODE_EVENTS` (`packages/core/src/webhooks.ts`) if the node should emit
   one.
6. Docs: the node catalog page renders from `NODE_SPECS`, but the prose around it is hand-written
   (`docs-sync`).

## D1 schema and migrations

**Rule.** `packages/db/src/schema.ts` matches `packages/db/migrations/*.sql`. A change adds the next
numbered migration (`NNNN_snake_name.sql`); an applied one (anything on `origin/main`) is never
edited. A migration must work with the code already deployed: add first (expand), and drop or
rename only in a later change once nothing deployed uses it (contract).

**Why.** CI applies migrations before it deploys the Workers, and a failed smoke test rolls the
Workers back but not D1. So for a while the *old* Workers run against the *new* schema.

**Check.**
- Next number: `ls packages/db/migrations | tail -1`.
- Expand-only: the new file has no `DROP COLUMN`, `DROP TABLE`, `RENAME`, or `NOT NULL` column
  without a default on an existing table.
  `grep -niE 'drop |rename |not null' packages/db/migrations/<new>.sql`, then judge each hit.
- `apps/engine/tests/migrations.test.ts` applies migrations up to one and runs it against rows in
  the older shape; a data-moving migration gets a case there.
- Local: `pnpm db:migrate:local`. Never `--remote`.

## Agentic checkout pricing

**Rule.** UCP (`apps/engine/src/ucp/`) prices a session only with the checkout flow's own pricing
nodes, taken by `quoteNodes` (`packages/core/src/checkout.ts`) and run in `apps/engine/src/ucp/quote.ts`.

**Why.** The PaymentIntent held at completion must be exactly the amount the flow's authorize node
adopts. Any second pricing path disagrees with the flow sooner or later.

**Check.** A new price, tax or shipping computation under `apps/engine/src/ucp/` that doesn't go
through `quoteNodes` is a finding. What UCP serves is tested against the vendored schemas in
`packages/core/tests/fixtures/ucp` (never edited by hand).

## The product catalog

- **Routing is frozen.** The shard hash and counts in `packages/core/src/product/routing.ts` are
  pinned by golden values in `packages/core/tests/product-routing.test.ts`. Changing them strands
  every stored product. Never update an expected value; adding a case is fine.
- **Types change additively.** A product type changes only by a new version that
  `typeChangeIssues` accepts.
- **Document format.** A change to a published document's shape bumps `DOC_FORMAT`
  (`packages/core/src/product/paths.ts`) and needs a reindex.
- **Outbox.** A write lands in the shard's transaction with its outbox row and publishes from the
  alarm (`apps/catalog/src/shard.ts`, `publish.ts`). Never publish outside the outbox.
- **No cross-shard waits.** A shard never awaits another shard while holding a transaction or
  `blockConcurrencyWhile`: two shards claiming aliases from each other would deadlock.
- **Typed binding.** Callers type the catalog binding as `ProductCatalogRpc`.
- **Per-deployment resources.** A new catalog resource goes in `scripts/fleet.ts` and
  `scripts/provision.sh`.
- **Edge.** `apps/catalog-edge` is read-only, serves only what the publisher wrote, and reaches
  its cached `Delivery` entrypoint by canonical URL (`routes.ts`). Purges are rationed (Free-plan
  limits): freshness comes from `max-age` and ETag revalidation; only urgent writes queue a purge.

## Plugins

Plugins (`plugins/<id>/`, contract in `packages/core/src/plugins.ts`, see `docs/plugins.md`):

- import only `@orderloop/core`, `@orderloop/design` and `@orderloop/plugin-sdk`, and are built with
  `definePlugin` (it checks the manifest against the handlers and the page principal and role);
- declare `apiVersion` (`PLUGIN_API_VERSION`), and get buyer details only with
  `personalData: 'send'`;
- read credentials only from the `secrets` their manifest declares, which each deployment sets as
  `PLUGIN_<ID>_<NAME>` and the deploy hands to that plugin alone (`pluginOwnSecrets`);
- own their D1 database and migrations (the core schema never holds a plugin's tables);
- namespace node types `<id>.<name>`;
- key every write and compensation by order id + step key (the SDK's `key`), every delivery by its
  payload id;
- pass `pluginContract` (`@orderloop/plugin-sdk/contract`) in their own tests.

The engine checks what a plugin returns (`checkExecResult`), times its calls out, and puts its
`vars` under `vars.<id>`. The web app forwards only `/plugins/<id>/…`, with allowlisted request
headers, and strips cookies from and forces its CSP and framing headers onto every plugin
response (`apps/web/app/lib/plugins.server.ts`).

The core never imports plugin code and keeps working with no plugin bound; the engine's default
test project runs without one. `plugins/example` is a test fixture no deployment may install
(check `deployments/*.jsonc`).

## Ledger design tokens

Tokens live in `apps/web/app/app.css`; `packages/design/src/tokens.ts` mirrors them (its tests fail
if they differ) and generates the docs theme. After changing a token: change `tokens.ts`, run
`pnpm sync:theme`. Don't reuse styling from other projects; the design is recorded in
`apps/docs/DESIGN.md`.

## Endpoints, deploys, toolchain

- Endpoint names never end in a trailing z: `/health`, `/ready`, `/auth`.
- Production deploys from CI only. Merging to `main` runs `.github/workflows/ci.yml`: verify, then
  the fleet in rings (staging → internal → canary → general) through `deploy.yml`, which records a
  D1 bookmark, migrates D1, deploys catalog, catalog-edge, plugins (with their own migrations),
  engine, web and docs, smoke-tests, and rolls the Workers back on failure (D1 stays migrated;
  `docs/deploy.md` "Restoring D1"). If a deploy job fails, re-run its failed jobs.
- vitest is pinned to 5.0.3: 5.0.4's module cache breaks `@cloudflare/vitest-plugin`.
- `@callable()` uses TC39 decorators; `apps/web/vite.config.ts` and `apps/engine/vitest.config.ts`
  include `agents/vite` so they're transformed.
- After changing an app's `wrangler.jsonc`: `pnpm --filter @orderloop/<app> types`.
