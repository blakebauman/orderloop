---
name: testing
description: How Order Loop is tested and where a new test goes. Covers each package's vitest environment (node or workerd), the engine's real Workflows with mock AI and the Stripe fake, the plugins and stripe projects, the planner's simulate helper, migration tests, frozen golden values and vendored fixtures, and the recorded docs runs. Preloaded by the test-engineer agent; use it when writing, fixing or choosing where to put a test.
license: MIT
metadata:
  repo: orderloop
---

# Testing Order Loop

`docs/testing.md` is the full reference (every test file and what it covers). Read the section
for the package you're in before adding a test; this page is the part you need every time.

## Where a test goes

| Change in | Test in | Runs in |
|---|---|---|
| `packages/core/src/graph.ts` (planner) | `packages/core/tests/graph.test.ts`, with `simulate(graph, choose)` | node |
| Other `packages/core/src/**` | `packages/core/tests/<module>.test.ts` | node |
| `packages/design` tokens | `packages/design` tests (compare with `app.css`) | node |
| Engine Workflow, nodes, agent, MCP, A2A, UCP | `apps/engine/tests/*.test.ts` (project `engine`) | workerd |
| Engine with a plugin bound | `apps/engine/tests/plugins/**` (project `plugins`) | workerd |
| Payments with Stripe's shapes | `apps/engine/tests/stripe/**` (project `stripe`, `tests/stripe-fake.ts`) | workerd |
| A migration that moves data | `apps/engine/tests/migrations.test.ts` | workerd |
| `apps/catalog`, `apps/catalog-edge` | their `tests/` | workerd |
| `apps/web/app/lib/**` | `apps/web/tests/*.test.ts` | node |
| `deployments/`, `scripts/fleet.ts` | `scripts/fleet.test.ts` (`pnpm test:fleet`) | node `--test` |
| `.claude/` hooks | `.claude/hooks/tests/*.test.sh` (`pnpm test:toolkit`) | bash |

## Running

```bash
pnpm --filter @orderloop/core test                       # fast; most logic lives here
pnpm --filter @orderloop/engine test                     # all three engine projects
pnpm --filter @orderloop/engine exec vitest run --project engine tests/ucp.test.ts
pnpm --filter @orderloop/engine exec vitest run --project plugins
pnpm --filter @orderloop/engine exec vitest run --project stripe
pnpm test                                                # everything, through turbo
```

## Engine tests: what's real and what isn't

- Real: the `OrderAgent` Durable Object, the `OrderLoop` and `Replenish` Workflows, local D1 and
  R2, from the engine's own `wrangler.jsonc` (`remoteBindings: false`).
- Mocked: AI (`AI_MODE: 'mock'`, heuristics for every AI node, the copilot and the assistant) and,
  in the `stripe` project, Stripe (`installStripeFake()` spies on `fetch`). No network, no account.
- Waits: `introspectWorkflow(env.ORDER_LOOP)` and
  `modifyAll(m => { m.disableSleeps(); m.disableRetryDelays(); m.forceEventTimeout({ name }) })`,
  where `name` is the step key (`mgr#1`).
- Setup: `tests/setup.ts` applies `packages/db/migrations`, then the demo data in
  `packages/db/seed`. Tests order against that demo data.
- Signed callers: `tests/principal.ts` `signed(p, path)`; UCP platforms via `tests/ucp-helpers.ts`.
- `testTimeout` is 60 s. A slow test usually means a wait wasn't disabled or forced.

## Rules

- **vitest is pinned to 5.0.3** in `pnpm-workspace.yaml`; 5.0.4 breaks `@cloudflare/vitest-plugin`.
- **Never change a golden value** in `packages/core/tests/product-routing.test.ts`. A failing
  golden test means the code change is wrong, not the test.
- **Never edit `packages/core/tests/fixtures/ucp`.** They're UCP's published schemas, vendored
  unchanged; Biome ignores the folder.
- **Check node ids against `packages/core/src/templates.ts`** before writing them into a test.
- **The docs home page's runs** (`apps/docs/src/data/runs/*.json`) are checked by
  `apps/engine/tests/docs-sample-run.test.ts`. If a flow change makes it fail, re-record the run
  and say so in the PR; don't loosen the test.
- **Test the failure path too**: a refusal, a replay, an expired or forged credential, a retry.
  Most of this codebase's bugs are in the second run of something.
- A test that only passes with a sleep is wrong; force the event or disable the delay.
