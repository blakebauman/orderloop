# Roadmap

Planned work, roughly in priority order. Most of it ports ideas from commerceworker, as a node, a connector or an API surface; the flow model stays unchanged.

## Next

### Address validation node
Add a `commerce.address_validate` node. It normalises the ship-to in `order.meta.shipTo`: trim, uppercase the country and region codes, check the postcode format. Its outputs are `valid`, `corrected` and `invalid`. A corrected address puts its suggestion in `vars.suggestedAddress`, so a flow can send it to an approval or ask the customer. Start with a deterministic validator. A real provider (USPS, Loqate) plugs in behind the same connector, like the other mocks in `apps/engine/src/connectors.ts`.

### Per-node timing and metrics
- Record each node's duration (`startedAt` and `endedAt` are already reported to the OrderAgent).
- Roll durations up into a D1 table: a new migration.
- Add dashboard tiles: completion rate by order type, p95 duration per node type, revenue per period, refund rate.
- The rollup can run on the Replenish Workflow's daily cron, or on a second schedule on the same binding.

### Roles instead of a single `APP_PASSWORD`
Add `viewer`, `approver` and `operator` roles, so the approvals `by` field is a real identity and only approvers can decide. API tokens get a role as well. This keeps the web app's current session cookie, and `apps/web/app/lib/auth.server.ts` gains a principal with a role.

### Pricing priority chain
`commerce.price` uses a contract price, falling back to list price. Make it a chain of sources, each with a priority and a `stopProcessing` flag:
1. price book
2. contract price
3. tier or volume price
4. list price

Pricing sources go in D1. The resolver lives in `packages/core`, is pure and is unit tested, like `policy.ts`.

### Per-order presentment currency
`currency` is already on the order input but is fixed to USD in practice. Store each order's currency on the order row. Format amounts by currency in the UI, and use the currency in documents, refunds and webhook payloads. Reporting converts to a base currency.

## Gaps in shipped features

- **Relative times can flicker on load.** "in 42m" and "3m ago" are computed from `Date.now()` on the server and again in the browser, so they can differ by a unit at a minute boundary and log a hydration warning. Render them only after hydration, as `useDateTime` (`apps/web/app/lib/use-date-time.ts`) does for absolute times.
- **Restock and a part-finished reserve aren't keyed by step.** `restock` adds stock with no record of the step that did it, so a step retried after its write restocks twice. `reserveInventory` returns early once any line is held, so a step that died after holding some lines never holds the rest. Record stock movements per step key and line, like reservations, and drop the early return.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
