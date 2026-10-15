# Order Loop

An agent loop for commerce. Every order is a durable loop that runs from intake to its outcome: B2B, retail and direct-to-consumer, marketplace, subscription, procurement and replenishment orders, from any channel. Each loop is defined as a flow graph you draw in React Flow, and it runs entirely on Cloudflare: Workers, Workflows, Durable Objects (the Agents SDK), Workers AI, D1 and R2.

## How it works

```
browser ──► apps/web (React Router on Workers) ──RPC──► apps/engine
              │ D1: flows + versions, orders index,        ├─ OrderAgent DO (one per order, Agents SDK):
              │     approvals, mock back office            │    live state, waits, approvals
              │ flow editor, live order view, /api/v1       ├─ OrderLoop Workflow: interprets the pinned
              ├─ /agents/order-agent/:id WebSocket ────────►│    flow graph (step.do / sleep / waitForEvent / rollback)
              ├─ /agents/assistant-agent/* WebSocket ──────►├─ AssistantAgent DO (one per person): the workspace assistant
              ├─ /mcp (OAuth, MCP clients) ────────────────►│    its tools, served to MCP clients
              └─ /a2a (OAuth, A2A agents) ─────────────────►├─ A2AAgent DO (one per caller): A2A tasks that follow orders
                                                            ├─ Replenish Workflow (cron schedule): daily stock review
storefront, marketplace, POS ── POST /api/v1/webhooks/orders (signed, on apps/web)
Shopify, EDI X12 850 ── POST /api/v1/channels/shopify/orders, /api/v1/channels/edi/850
inbound order email ── Cloudflare Email Routing ── email() ─►├─ Email intake: orders@ / po@ / purchasing@ start orders
                                                            └─ Workers AI (extract, classify, risk, forecast, router,
                                                               copilot, assistant), R2 (POs, invoices, inbound docs)
```

- **Flows are data.** A flow is a JSON graph of catalog nodes (`packages/core/src/catalog.ts`):
  - triggers;
  - commerce steps (validate, address check, policy check, price, tax, credit, reserve, authorize, invoice, ship, route fulfillment, pickup, hand over, digital delivery, split by seller, seller payouts, return label, refund, …);
  - control (condition, approval, wait for event, wait, loop, continue-as-new, end);
  - AI (extract, classify, risk score, forecast, summarize, and an LLM **router** that chooses a branch).

  The editor saves drafts to D1. Publishing creates an immutable version, and each order pins the version it started on.
- **One generic Workflow interprets every flow** (`apps/engine/src/workflow.ts`). A pure planner in `packages/core/src/graph.ts` decides what can run:
  - **AND-join that tolerates untaken branches:** a node runs once its inputs are resolved, as long as at least one was taken.
  - **Skip propagation:** a node whose inputs were all untaken is skipped, and so is everything downstream that depends only on it.
  - **Loops:** loops use back-edges into a Loop node's `next` input.

  The Workflow makes each node one memoized `step.do` named `${nodeId}#${run}`, so loop iterations replay deterministically.
- **Saga rollback is native.** Reserve inventory, authorize payment and create shipment register `rollback` handlers on their step. An End node with outcome `failed` throws `NonRetryableError`, and Workflows then runs the compensations in reverse order.
- **Humans and other systems resume orders with events.** Approval and Wait-for-event nodes call `step.waitForEvent` with a timeout; approvals escalate when it expires. The OrderAgent records every open wait and delivers decisions and business events (for example `payment.received`) to the right instance.
- **Live UI.** The Workflow reports sequenced plan snapshots to the order's OrderAgent, which ignores stale or replayed ones, and the agent syncs its state to every open order page through `useAgent`. The same socket carries actions: approve, reject, deliver event, and cancel.
- **Long-lived subscriptions** loop over billing periods, then use **continue-as-new**: they start a fresh Workflow instance with their variables carried over, so the step history never grows without bound.
- **Mock connectors** (`apps/engine/src/connectors.ts`) cover inventory, payments, shipping, documents and the outbox, against D1 and R2. Every write is keyed by its step and every compensation is idempotent. They are where real adapters (Stripe, a WMS, carriers, an ERP) plug in. To exercise failure paths, set `meta.simulate` to one of `out_of_stock`, `payment_decline`, `charge_fail` or `three_way_mismatch`.
- **Orders arrive by email too.** Cloudflare Email Routing delivers `orders@`, `po@` and `purchasing@` to the engine's `email()` entrypoint (`apps/engine/src/email.ts`). Mail from an authenticated customer address, company domain or allowlisted sender starts the mailbox's flow. The body and attachments (PDF and Office files through Workers AI `toMarkdown`) become the order's document for the AI extract node, and the Message-ID is the idempotency key. See the [Email intake guide](https://docs.orderloop.app/guides/email-intake/).
- **A workspace assistant.** A panel (⌘J) backed by one `AssistantAgent` Durable Object per person answers from live data through role-checked tools. Deciding an approval, delivering an event, cancelling, publishing a flow and running the stock review show a confirm card first; flow changes come back to the editor as proposals. See the [assistant guide](https://docs.orderloop.app/guides/assistant/).
- **AI never blocks an order.** Every model call uses JSON mode with a schema, has a 20-second cap, and falls back to a deterministic heuristic. Set `AI_MODE=mock` to use the heuristics only.

See [ROADMAP.md](ROADMAP.md) for planned work.

## Repository

| Path | Role |
|---|---|
| `apps/web` (`@orderloop/web`) | Dashboard, flow editor (palette, canvas, inspector, assistant), live order view, approvals inbox, back office, REST API. React Router on Workers |
| `apps/engine` (`@orderloop/engine`) | OrderAgent and AssistantAgent DOs, OrderLoop and Replenish Workflows, node executors, connectors, AI, `EngineApi` RPC |
| `apps/docs` (`@orderloop/docs`) | Documentation site (Starlight), deployed as a static-assets Worker. Reference pages render from `@orderloop/core` at build time |
| `packages/core` (`@orderloop/core`) | No bindings: flow schema, node catalog, planner and validation, layout, JSON Logic expressions, templates, RPC contract |
| `packages/design` (`@orderloop/design`) | Ledger tokens as data, held to `apps/web/app/app.css` by a test; generates the docs theme (`pnpm sync:theme`) |
| `packages/db` (`@orderloop/db`) | D1 schema (Drizzle), migrations and seed data, flow persistence |
| `packages/ui` (`@orderloop/ui`) | shadcn/ui primitives, consumed as raw `.tsx` |
| `packages/typescript-config` | Shared tsconfig bases |

## Develop

```bash
pnpm install
pnpm db:migrate:local
pnpm db:seed:local      # demo customers, catalog, stores and rates (migrations seed none)
pnpm web:dev            # web + engine in one Vite session (engine runs as an auxiliary Worker)
pnpm test               # core planner tests, engine Workflow e2e (workerd), web tests
pnpm lint && pnpm check-types
```

Open the dashboard and run one of the scenarios (they appear once the demo data is loaded). In dev, `TIME_SCALE` is `1440` (set in `apps/web/vite.config.ts`), so a day becomes a minute; deployed, waits run in real time. Workers AI always calls your Cloudflare account, even in local dev; if the call fails or times out, the node uses its heuristic.

## REST API

Authenticate with `Authorization: Bearer ol_live_…`, an API token an operator creates on the Team page. Each token and person has a role: `viewer` reads, `approver` also decides approvals, `operator` does everything else. `APP_PASSWORD`, when set, is a break-glass operator sign-in and bearer token. With no `APP_PASSWORD` and no people, the dashboard and API are open on localhost only (local development); any other host answers `503` until you set `APP_PASSWORD`.

```
GET  /api/v1/openapi.json                    OpenAPI 3.1 description (public)
GET  /api/v1/flows
POST /api/v1/orders                          { "flowId": "tpl-storefront-order", "input": { "model": "b2c", "channel": "web", "customerId": "cus_ada", "lines": [{ "sku": "MON-27", "qty": 1 }] } }
                                             Idempotency-Key header: a repeat returns 200 and the same order,
                                             finishing the start if the first request failed part-way;
                                             the same key with a different body returns 422
GET  /api/v1/orders?model=&channel=&status=&q=
GET  /api/v1/orders/:id                      live state from the order's agent
POST /api/v1/orders/:id/events               { "event": "payment.received", "payload": {} }   ← webhooks
POST /api/v1/orders/:id/approvals/:nodeId    { "decision": "approved" | "rejected", "by": "…", "note": "…" }
POST /api/v1/orders/:id/cancel               { "reason": "…" }
GET  /api/v1/audit-events?type=&before=     security audit log (operator)
```

### Outbound webhooks

Subscribers receive signed order events: `order.paid`, `order.invoiced`, `order.shipped`, `order.ready_for_pickup`, `order.delivered`, `order.refunded`, `order.payout_scheduled`, `order.completed`, `order.declined` (a policy or approval “no”), `order.cancelled` and `order.failed`.

```
GET    /api/v1/webhook-subscriptions
POST   /api/v1/webhook-subscriptions               { "url": "https://…", "events": ["order.shipped"] }   ← returns the secret once
DELETE /api/v1/webhook-subscriptions/:id
GET    /api/v1/webhook-subscriptions/:id/deliveries
```

Ending events cover every way an order ends: an End node, a cancel from the UI or API (`order.cancelled`, sent by the order's agent), and a node that throws (`order.failed`, with the node and its error).

Each delivery is signed with the subscription's secret in the same `X-OrderLoop-Signature` scheme as inbound events, so `verifyWebhook` checks it. `X-OrderLoop-Delivery` stays the same across retries; use it to dedupe. A delivery runs in its own `${nodeId}#${run}:emit` step and is retried with backoff. If the endpoint is still down when retries run out, the delivery is left `failed` and the order carries on.

### Signed webhooks

External systems start and resume orders without a token by signing the raw body with their integration's secret. An operator creates one integration per system with `POST /api/v1/integrations` (`{ name, events, startOrders, flows, channel }`), which returns its id and secret once; the scope limits what its signatures can do. `POST /api/v1/integrations/:id/rotate` issues a new secret and keeps the old one working for 24 hours.

```
POST /api/v1/webhooks/events
X-OrderLoop-Signature: t=<unix seconds>,k=<integration id>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

{ "orderId": "ord_…", "event": "payment.received", "payload": { "amount": 3106.78 } }
```

Signatures older than 5 minutes are rejected, and a request outside the integration's scope gets `403`. The response is `200 { delivered: true }`, or `409` when no node is waiting for that event yet, so the sender's retry policy can deliver it later. `signWebhook(secret, body, undefined, integrationId)` in `@orderloop/core` produces the header.

Storefronts, marketplaces, POS systems and other channels start orders the same way:

```
POST /api/v1/webhooks/orders
X-OrderLoop-Signature: t=…,k=…,v1=…

{ "model": "b2c", "channel": "web", "externalId": "shop-1001", "contact": { "email": "sam@example.com" },
  "lines": [{ "sku": "MON-27", "qty": 1 }], "shipTo": { "line1": "1 Main St", "city": "Austin", "postalCode": "78701", "country": "US" } }
```

The flow is `flowId` when given, else the `ORDER_ROUTES` entry for `model:channel` or `model:*` (a JSON var on the web Worker), else the model's default template. The channel and `externalId` identify the order: a repeat returns `200` and the same order, the same pair with a different body returns `422`, and a new order returns `201 { orderId, flowId }`.

### Channel adapters

Two channels connect without producing that payload themselves:

- **Shopify:** point an `orders/create` webhook at `POST /api/v1/channels/shopify/orders` and set the app's client secret as `SHOPIFY_WEBHOOK_SECRET` on the web Worker. The order is verified by `X-Shopify-Hmac-Sha256`, mapped (Shopify's SKUs, prices and shipping address) and started once per Shopify order.
- **EDI X12 850:** an EDI provider posts the raw interchange to `POST /api/v1/channels/edi/850` with an operator API token. `EDI_PARTNERS` maps each partner's ISA sender id to a customer; every purchase order in the interchange becomes a B2B order on the `edi` channel, and the response lists each one.

### Email intake

Send an order, order form or purchase order to `orders@orderloop.app` (or `po@`, or `purchasing@` for purchase requests) from a customer's address. The sender gets an acknowledgement with the order reference, and the Back office page lists every message received with its outcome. Who may send is covered in the [Email intake guide](https://docs.orderloop.app/guides/email-intake/); setting up Email Routing for your own domain is in [docs/deploy.md](docs/deploy.md).

## Docs

The docs site is `apps/docs`, published at [docs.orderloop.app](https://docs.orderloop.app) for the
people who use a workspace and the developers who integrate with one: guides, the REST API, a node
catalog generated from the catalog source, and an OpenAPI explorer. How OrderLoop is built,
configured, deployed and tested is in [`docs/`](docs/README.md), which isn't published.

```bash
pnpm docs:dev        # local preview
pnpm docs:build      # static build, then an internal link check
pnpm docs:deploy     # build and deploy the orderloop-docs Worker
```

## CI/CD

`.github/workflows/ci.yml` runs lint, type-check, build, tests, the fleet tests and a dependency audit on every push and PR. Production deploys from CI: each customer has a dedicated deployment listed in `deployments/` (at `<id>.orderloop.app`; OrderLoop's own is `orderloop.app`), and on `main` CI deploys them ring by ring (staging, internal, canary, general). For each one it records a D1 restore point, migrates D1, deploys the engine and the web app, smoke-tests `/health/deep`, and rolls back any Worker it deployed if a later step fails; see [docs/operations.md](docs/operations.md). Each deployment's job runs in its GitHub environment, which holds its secrets. If a deploy fails, re-run the failed job in GitHub Actions; the manual commands below are for a first deploy to a new account.

## Deploy

```bash
pnpm exec wrangler login
./scripts/provision.sh orderloop               # D1, R2, AI Gateway, GitHub environment
pnpm --filter @orderloop/web db:migrate:remote
pnpm --filter @orderloop/web exec wrangler secret put APP_PASSWORD
pnpm run deploy                                # engine first (web binds to it), then web
```

Waits run in real time once deployed (`TIME_SCALE` is `"1"` in `apps/engine/wrangler.jsonc`). Model calls go through the `orderloop` AI Gateway (`AI_GATEWAY_ID`), which logs them and rate-limits them; create a gateway with that id in a new account before deploying, or set the var to `""` to call Workers AI directly.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
