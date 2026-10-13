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

- **A half-started order can get stuck.** If `startOrder` fails after inserting the order row (agent init or Workflow create), a retry with the same key returns an order stuck in `queued`. On replay, check whether the Workflow instance exists and finish starting it, or mark the row failed so the key can be reused.
- **Idempotency keys don't fingerprint the request.** A repeat key with a different body silently returns the first order. Store a hash of the request and answer `422` on a mismatch, as Stripe does.
- **Relative times can flicker on load.** "in 42m" and "3m ago" are computed from `Date.now()` on the server and again in the browser, so they can differ by a unit at a minute boundary and log a hydration warning. Render them only after hydration, as `useDateTime` (`apps/web/app/lib/use-date-time.ts`) does for absolute times.
- **Partial returns restock every line.** `commerce.restock` restocks the whole order. It should restock only the lines in the `return.requested` payload.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
