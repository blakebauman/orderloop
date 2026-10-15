# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Order-operations staff at any business that sells or buys** (primary): B2B sellers and distributors, retailers and direct-to-consumer brands with stores, marketplace operators, subscription businesses, and procurement teams. They watch live orders, clear approvals, deliver business events, cancel or unstick orders, and draw or adjust the flows that orders run on. Each person has a role: `viewer` reads, `approver` also decides approvals, `operator` does everything else.
- **Customer service and store staff.** Answer buyers' "where is my order" questions from live order state, and hand over pickups and till sales.
- **Managers.** Oversee throughput, exceptions and what is waiting on whom.
- **Developers.** Integrate storefronts, marketplaces, POS systems and back offices through the REST API (`/api/v1`, bearer tokens with the same roles), signed inbound orders and events, outbound webhooks and email intake.

## Product Purpose

OrderLoop runs every commerce order, whatever the model (B2B, B2C, direct to consumer, marketplace, subscription, procurement, replenishment) and whatever the channel (web, mobile, POS, marketplace, email, API), as a durable agent loop from intake to outcome. Each loop is a flow graph drawn in the editor and interpreted by one generic Workflow on Cloudflare. Success means orders reach their outcome without a person chasing them. People step in only where a flow asks for them (approvals, events, exceptions), and when they do, they can see exactly where an order is and why.

## Positioning

Flows are data: an order pins an immutable flow version, and the live order view is that graph, running. Planner semantics (AND-joins that tolerate untaken branches, skip propagation, loops), saga rollback and waits for people or events are first-class. Neighbouring order tools hide this behind status fields. OrderLoop shows the loop itself.

## Operating Context

- The surfaces are the dashboard, the orders list and live order page, the approvals inbox, flows and the flow editor (palette, canvas, inspector, copilot), the back office (mock inventory and store stock, customers, marketplace sellers, pricing, payments, shipping, documents, outbox), the team page and the account page.
- Orders arrive from the dashboard, the REST API, signed inbound orders from storefronts, marketplaces and POS systems (`POST /api/v1/webhooks/orders`), and inbound email (`orders@`, `po@`, `purchasing@`). Each order has a commerce model and a channel.
- Live order state syncs over a WebSocket from each order's agent. Actions (approve, reject, deliver event, cancel, chat) travel on the same socket.
- AI exists today in two places. The **flow-editor copilot** drafts or edits a flow graph from a prompt and returns an explanation plus validation issues. The **per-order Chat tab** answers from order state through tools and prepares approve, reject and cancel actions, which a person confirms on the order page with the usual undo window.

## Capabilities and Constraints

- AI never blocks an order. Every model call uses JSON mode with a schema, has a 20-second cap and falls back to a deterministic heuristic. `AI_MODE=mock` runs on the heuristics alone.
- Models run on Workers AI.
- Decisions have an undo window. Publishing a flow creates an immutable version, and orders pin the version they started on.
- The web app talks to the engine only through `EngineRpc` and the order-agent socket.
- Roles are enforced for people and API tokens alike. A new workspace's first admin is created with a one-time setup code; a new code recovers admin access.
- Not planned: multi-tenancy, billing, plan gating.

## Brand Commitments

- The product name is written **OrderLoop** in UI copy.
- The voice is plain and exact, with sentence-case titles. Copy says what happened and why, never hype.
- The visual identity "Ledger" is established in `apps/web/app/app.css` and mirrored in `packages/design`. It must not resemble durablefibers or Supabase (no green brand; green means "succeeded" only).

## Evidence on Hand

- Seeded flow templates and scenarios across the models (for example `tpl-storefront-order` with a guest checkout, `tpl-omnichannel-order` with pickup at `loc_soho`, `tpl-pos-sale`, `tpl-marketplace-order` with sellers `sel_brightside` and `sel_kettle`, and `tpl-b2b-order` with customer `cus_northwind` and SKU `WID-100`), plus `meta.simulate` failure paths: `out_of_stock`, `payment_decline`, `charge_fail`, `three_way_mismatch`.
- No real customers, testimonials or usage metrics exist. Do not fabricate them.

## Product Principles

1. **Show the loop, not a status.** Every answer should point at where in the flow something is and why.
2. **People decide what can't be undone.** Automation and AI act freely on what is reversible. Moving money, cancelling, rejecting and publishing wait for a person.
3. **Never block on a model.** Every AI path has a deterministic fallback, and the product stays fully usable without it.
4. **The role is the boundary.** Whatever a person or token can't do, nothing acting on their behalf can do either.
5. **Idempotent by construction.** Any action can be retried safely, so the UI can be honest about retries and partial failures.
