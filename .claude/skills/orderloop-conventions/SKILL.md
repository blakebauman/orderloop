---
name: orderloop-conventions
description: The invariants Order Loop's code must keep, each with why it holds and how to check it. Background knowledge for any change to the engine, web app, core, catalog, D1 schema, plugins or CI; preloaded by the engineer, test-engineer and code-reviewer agents. Use when writing or reviewing code here and you need the rule behind a CLAUDE.md line, or the grep or test that proves a change keeps it.
license: MIT
user-invocable: false
metadata:
  repo: orderloop
---

# Order Loop conventions

CLAUDE.md states the rules in one line each. This skill is the working version: what each rule
protects, where it lives in the code, and how to tell whether a change keeps it. The full list is
in [references/invariants.md](references/invariants.md); read the sections your change touches.

## The shape of the system

- `packages/core`: pure TypeScript shared by everything. No bindings, no Cloudflare imports.
  Planner (`graph.ts`), node catalog (`catalog.ts`), templates, roles and principal signing
  (`roles.ts`), checkout and UCP (`checkout.ts`, `ucp/`), the product model (`product/`),
  webhooks, encryption, prompt-injection guards (`untrusted.ts`).
- `apps/engine`: the `OrderLoop` Workflow (`workflow.ts`), the `OrderAgent` Durable Object
  (`agent.ts`), node executors and compensations (`nodes.ts`), MCP, A2A, UCP, the assistant.
- `apps/web`: React Router on Workers. Reaches the engine only through `EngineRpc` and the routes
  it forwards with a signed principal.
- `apps/catalog` (sharded product catalog, outbox publishing) and `apps/catalog-edge` (read-only
  cached delivery).
- `packages/db`: D1 schema (`src/schema.ts`) and numbered migrations.
- `plugins/<id>`: optional Workers bound as `PLUGIN_<ID>`.
- `deployments/*.jsonc` + `scripts/fleet.ts`: one deployment per customer, deployed by CI in rings.

## Rules that a hook enforces

These fail fast, so you'll hear about them; the reasons are in invariants.md.

| Rule | Hook |
|---|---|
| No hand deploys, rollbacks, remote migrations or resource deletes | `guard-bash.sh` denies |
| Pushing main, force pushes, `gh pr merge`, remote D1 SQL, Worker secrets, provisioning | `guard-bash.sh` asks |
| An applied migration (on `origin/main`) is never edited | `guard-invariants.sh` denies |
| `packages/core/tests/fixtures/ucp` stays byte-for-byte upstream | `guard-invariants.sh` denies |
| No z-suffixed endpoints (`/health`, not `/healthz`) | `guard-invariants.sh` denies |
| Catalog routing golden values never change | `guard-invariants.sh` asks |
| Generated files (`theme.css`, `worker-configuration.d.ts`) aren't hand-edited | `block-generated.sh` denies |
| Path-specific rules when you edit a file | `rules-impact.sh`, from [references/rules-map.tsv](references/rules-map.tsv) |

## Rules only a reader can check

The ones that need judgement, in the order reviews most often find them broken:

1. **Workflow determinism.** Effects, clock reads and model calls only inside `step.do`; step
   names `${nodeId}#${run}` stable for published flows; scheduling only in `graph.ts`.
2. **Idempotency.** Connector writes keyed by step key; compensations idempotent; agent updates
   idempotent; plugin writes keyed by order id + step key.
3. **Boundaries.** core has no `env`; web never imports engine source; catalog-edge imports core
   only through zod-free subpaths (`product/paths`, `product/listing`, `product/search`); the core never imports plugin code.
4. **Trust.** The engine trusts only a principal signed for that path and unexpired; UCP
   platforms act only on their own checkouts; `/mcp` and `/a2a` tokens are not interchangeable.
   See the `security-model` skill.
5. **Data shape.** `schema.ts` matches the migrations; migrations expand before they contract;
   published product documents bump `DOC_FORMAT`; product types change only additively.
6. **Pricing.** UCP checkouts are priced only by `quoteNodes`.
7. **Catalog writes.** Outbox in the same transaction; no cross-shard await under a transaction.
8. **Completeness.** A new node type has its spec, executor, icon and (if `rollback: true`) its
   `ROLLBACKS` entry; a new wrangler resource is in `fleet.ts` and `provision.sh`; a documented
   surface has its docs updated in the same change.

## Before you say a change is done

Run the `preflight` skill (lint, type-check and tests for what the change touches). If the change
touched a documented surface, the docs move in the same change (`docs-sync`).
