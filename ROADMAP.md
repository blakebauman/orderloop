# Roadmap

Planned work, roughly in priority order. Most of it ports ideas from commerceworker, as a node, a connector or an API surface; the flow model stays unchanged.

## Next

### Roles instead of a single `APP_PASSWORD`
Add `viewer`, `approver` and `operator` roles, so the approvals `by` field is a real identity and only approvers can decide. API tokens get a role as well. This keeps the web app's current session cookie, and `apps/web/app/lib/auth.server.ts` gains a principal with a role.

### Per-order presentment currency
`currency` is already on the order input but is fixed to USD in practice. Store each order's currency on the order row. Format amounts by currency in the UI, and use the currency in documents, refunds and webhook payloads. Reporting converts to a base currency.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
