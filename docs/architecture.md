# Architecture

The two Workers, the service binding between them, the packages, the bindings and the connectors.

OrderLoop is two Workers in one pnpm monorepo. `orderloop-web` serves the dashboard, the flow
editor and the REST API; `orderloop-engine` runs orders. The web app reaches the engine only
through a service binding, and the engine has no public URL.

```
browser ──► orderloop-web (apps/web, React Router on Workers)
              │  D1: flows + versions, orders index, approvals, back office
              │  R2: order documents
              ├── ENGINE service binding ──RPC──► orderloop-engine (apps/engine)
              │                                     ├─ EngineApi      WorkerEntrypoint (RPC)
              ├── /agents/order-agent/:id ─fetch─►  ├─ OrderAgent     Durable Object, one per order
              ├── /agents/assistant-agent/* ─────►  ├─ AssistantAgent Durable Object, one per person
              └── /a2a (fetch, via OAuth) ───────►  ├─ A2AAgent       Durable Object, one per caller
                                                    ├─ OrderLoop      Workflow, one instance per generation
                                                    ├─ Replenish      Workflow, daily cron
inbound mail ── Email Routing ──email()────────────►├─ receiveEmail   email intake (email.ts)
                                                    └─ Workers AI, D1, R2
```

## Packages

| Path | Role |
|---|---|
| `packages/core` (`@orderloop/core`) | Flow schema, node catalog, planner and validation, inbound order payload and routing, layout, JSON Logic expressions, policy rules, address checks, the pricing chain resolver, templates, webhook signing, the `EngineRpc` contract. No bindings and no Cloudflare imports |
| `packages/db` (`@orderloop/db`) | Drizzle schema for D1, numbered SQL migrations, demo seed data (`seed/`, local and tests only), flow persistence (`getFlowVersionJson`, `publishFlow`) |
| `packages/ui` (`@orderloop/ui`) | shadcn/ui primitives, consumed as raw `.tsx` |
| `apps/engine` (`@orderloop/engine`) | `OrderAgent`, `AssistantAgent`, `OrderLoop`, `Replenish`, node executors, connectors, AI calls, outbox, `EngineApi` |
| `apps/web` (`@orderloop/web`) | Dashboard, editor, live order view, approvals inbox, back office, `/api/v1` |
| `apps/docs` (`@orderloop/docs`) | This site |

`packages/core` is pure TypeScript so its semantics can be unit tested in Node: anything that needs
`env` belongs in an app. The planner lives there, not in the Workflow
(see [Planner](planner.md)).

## The engine contract

`EngineRpc` in `packages/core/src/api.ts` is the whole surface the web app may use:

| Method | What it does |
|---|---|
| `startOrder(input)` | Inserts the order row, initialises its `OrderAgent`, creates generation 1 of `OrderLoop`. Honours `idempotencyKey` |
| `startOrderOnce(input)` | Starts an order at most once per idempotency key (`POST /api/v1/orders` with an `Idempotency-Key`, signed inbound orders and email intake use it); a replay returns the existing order, or `{ mismatch: true }` for a different request |
| `sendEvent(orderId, event, payload?)` | Delivers a business event to the node waiting for it; returns `{ delivered, nodeId? }`, with `notFound` for an unknown order |
| `decide(orderId, nodeId, decision, by, deciderId, note?)` | Approves or rejects the approval a node waits on. `by` is the name the record carries, `deciderId` the principal, checked against `orders.started_by` when the workspace's `approval_separation` is `on`; returns `{ ok: true }` or `{ ok: false, reason }` (`not_found`, `not_waiting`, or `own_order` with the refusal in `error`) |
| `cancel(orderId, reason)` | Terminates the Workflow and compensates; returns `{ ok: true }` or `{ ok: false, reason }` (`not_found`, `finished`) |
| `snapshot(orderId)` | The agent's `OrderState`, or `null` for an unknown order |
| `copilot(req)` | Edits or creates a flow graph from a prompt |
| `intakeMailboxes()` | The email intake mailboxes (local part → flow id) from the engine's `INTAKE_MAILBOXES`, for the back office |
| `runReplenish()` | Creates a `Replenish` instance now |

`EngineApi` (`apps/engine/src/api.ts`) implements it as a `WorkerEntrypoint`. Every method except
`startOrder`, `startOrderOnce`, `copilot`, `intakeMailboxes` and `runReplenish` forwards to the order's agent via
`ORDER_AGENT.getByName(orderId)`. `EngineApi` trusts its caller: authorization happens in the web
app before the call. The web app types its `ENGINE` binding with `EngineRpc` and never imports
engine source.

## Request routing

`apps/web/workers/app.ts` routes every request before React Router sees it:

| Path | Handling |
|---|---|
| `GET /health` | `{ ok: true, service: "orderloop-web" }` |
| `GET /health/deep` | `runHealthChecks` over this Worker's D1 and R2 and `EngineRpc.health()` (the engine's D1 and R2): `{ ok, service, checks: { db, docs, engine } }`, each `"ok"` or `"fail"`, with `503` when any fails. The deploy smoke test calls it |
| `POST /api/v1/webhooks/events` | `handleSignedEvent`: authenticated by `readSigned`, an HMAC with the secret of the integration the signature names (`k=`, `findIntegration` in `apps/web/app/lib/integrations.server.ts`; the previous secret too during a rotation), then held to its scope (`allowsEvent` in `packages/core/src/integrations.ts`: its events, and its channel's orders only) |
| `POST /api/v1/webhooks/orders` | `handleSignedOrder`: the same HMAC check (`readSigned`), then `inboundOrderSchema`, the integration's scope (`allowsOrder`: it may start orders, on its channel, naming only its `flows`), a currency check, the flow from `flowId`, `ORDER_ROUTES` or the model's default (`flowForOrder`), a check that it is published, and `EngineRpc.startOrderOnce` keyed `order:<channel>:<externalId>`. See [Inbound orders](https://docs.orderloop.app/guides/inbound-orders/) |
| `POST /api/v1/channels/shopify/orders` | `handleShopifyOrder`, before authentication: `verifyShopifyHmac` against `SHOPIFY_WEBHOOK_SECRET` (`503` unset, `401` bad), other `X-Shopify-Topic` values answered `{ ignored: true }`, then `shopifyToInbound` with `customerIdByEmail` and the shared `startInbound` (currency, routing, publish check, `startOrderOnce`). See [Channel adapters](https://docs.orderloop.app/guides/channel-adapters/) |
| `GET /api/v1/openapi.json` | The OpenAPI document, public, `cache-control: public, max-age=300` |
| `/api/v1/*` | `apiPrincipal` (an `ol_live_` token, `APP_PASSWORD`, or the session cookie; `401` for none or an expired token, `429` when throttled, `403` while the person's two-factor setup is due), then `handleApi(request, caller)`, which checks each route's role. `POST /api/v1/channels/edi/850` is one of its routes (`operator`): `parseX12`, the sender looked up in `EDI_PARTNERS`, then `x12850ToInbound` and `startInbound` for each transaction |
| `/agents/order-agent/*`, `/agents/assistant-agent/*` | `principal`, then proxied to the engine's `fetch` (`routeAgentRequest`) with the caller in `x-orderloop-principal` (replacing any the browser sent) and `cookie` and `authorization` deleted, carrying the Agents SDK WebSocket. For the assistant the instance name is replaced with the caller's id, so everyone reaches only their own |
| `GET /.well-known/agent-card.json` | `agentCard(origin)` from core, public, `cache-control: public, max-age=300` |
| `/mcp`, `/a2a`, `/.well-known/oauth-*`, `/oauth/*` | `oauthFetch` (`apps/web/app/lib/oauth.server.ts`), before everything else. `/oauth/authorize` is excluded: it is the consent page, a React Router route |
| `/docs/orders/*` | `principal`, then the R2 object, served with `content-security-policy: default-src 'none'; style-src 'unsafe-inline'` |
| everything else | React Router (UI routes guard themselves with `requireUser(request, role)`) |

Before the API, agent and React Router branches, a browser request that changes state or opens a
WebSocket without a bearer token must pass `crossOrigin` (`apps/web/app/lib/origin.ts`): its
`Origin`, or failing that `Sec-Fetch-Site`, must show the app's own origin, or it gets `403`. See
[Cross-site requests](https://docs.orderloop.app/guides/team-and-roles/#cross-site-requests).

`apps/web/app/lib/auth.server.ts` resolves the principal: a `__Host-ol_session` cookie (a `sessions`
row), the shared-password cookie, or a bearer token. With `APP_PASSWORD` unset and no `users`, it
is an open admin, which is the local dev default; `openModeRefused` makes the Worker answer `503` on any other host. See [Team and roles](https://docs.orderloop.app/guides/team-and-roles/). The engine's own
`fetch` (`apps/engine/src/index.ts`) answers `/health` and routes agent requests; with
`workers_dev: false` and no routes it is reachable only through the binding. Its `email` handler
receives messages from Email Routing and hands them to `receiveEmail`; see
[Email intake](https://docs.orderloop.app/guides/email-intake/).

## REST API

The `/api/v1` routes are in `apps/web/app/lib/api.server.ts`. Request bodies in the OpenAPI
document (`apps/web/app/lib/openapi.ts`, served at `/api/v1/openapi.json` and rendered by the docs'
explorer) are generated from the zod schemas the handlers validate with
(`apps/web/app/lib/api-schemas.ts`), so they can't drift. Event payloads are capped at 32 KiB
(`MAX_EVENT_PAYLOAD_BYTES`, `packages/core/src/api.ts`); the OrderAgent's `deliver`, `decide` and
`cancel` enforce the same bounds on the live socket as the REST schemas do.

## MCP

`/mcp` is the assistant's tools for MCP clients. The web Worker routes it, with the OAuth
discovery, registration and token paths, to `@cloudflare/workers-oauth-provider`
(`apps/web/app/lib/oauth.server.ts`). There it is one `OAuthAuthorizationServer` (issuer the
origin; resources `/mcp` and `/a2a`, with `/mcp` the default and the resource of grants made
before A2A) and one `OAuthResourceServer` per endpoint, which publishes
`/.well-known/oauth-protected-resource/<path>` and accepts only tokens issued for it. The
authorization server does dynamic client registration, Client ID Metadata Documents, tokens of
1 hour (access) and 30 days (refresh), and keeps grants in KV `OAUTH_KV`. The consent page is `routes/oauth-authorize.tsx`; the grant's `props` are
the approver and the role they chose. A bearer that is not an issued
token (one not shaped `<user>:<grant>:<secret>`) is checked as `ol_live_` or `APP_PASSWORD` by
`apiPrincipal`, with its throttling and expiry, on either endpoint.

`forward` resolves the caller (for a grant, `grantPrincipal` re-reads the person: disabled means
refused, and the role is the lower of granted and current), refuses a pending two-factor setup,
deletes `authorization` and `cookie`, sets `x-orderloop-principal` and fetches the engine over the
`ENGINE` binding. The engine's `fetch` and `EngineApi.fetch` hand `/mcp` to `handleMcp`
(`apps/engine/src/mcp.ts`): `createMcpHandler` from `agents/mcp/server`, a fresh
`McpServer` (`@modelcontextprotocol/server`) per request, no session. It registers only the
`ASSISTANT_TOOLS` the role allows, with `TOOL_INPUTS` and `runTool` from `assistant/tools.ts`, the
code the assistant runs too, and passes `via: 'MCP'` so `runAction` records `<email> via MCP`. See
[MCP server](https://docs.orderloop.app/reference/mcp/).

## A2A

The Agent Card at `/.well-known/agent-card.json` is built from the request's origin by `agentCard`
(for an `A2A-Version: 1.0` request) or `legacyAgentCard` (the 0.3 shape, for anyone else) in
`packages/core/src/a2a.ts`. Push
notification URLs pass `isWebhookUrl` (`packages/core/src/webhooks.ts`), the same rule as outbound
webhook subscriptions.


`/a2a` is the same tools, plus `place_order` and `chat`, for Agent2Agent clients. `forward` is the
same function as for MCP, aimed at `/a2a`. The engine's `fetch` and `EngineApi.fetch` hand it to
`handleA2A` (`apps/engine/src/a2a/route.ts`), which sends it to
`env.A2A_AGENT.getByName` named `<kind>:<id>` after the principal, so each caller has an `A2AAgent` Durable Object
(`agent.ts`, migration `v3`). A 0.3 method name (`message/send`, …) goes to the SDK's
`LegacyJsonRpcTransportHandler`; otherwise it checks the `A2A-Version` header (absent means 1.0).
Both run JSON-RPC through the same `@a2a-js/sdk` `DefaultRequestHandler`, with SSE for `SendStreamingMessage` and
`SubscribeToTask`. `SqlTaskStore` (`store.ts`) keeps tasks in `tasks` and the order a task follows
(or a chat action waiting for a confirm) in `task_links`; for an unfinished order, `load` and
`list` take the status from the `OrderAgent` snapshot through `orderTaskState` in
`packages/core/src/a2a.ts`. `OrderLoopExecutor` (`executor.ts`) reads a data part
`{ skill, input }` into `runTool` with `via: 'A2A'`, starts orders with `startOrderOnce` keyed
`a2a:<principal id>:<messageId>`, runs `chat` with `assistantModel` (an action it proposes stops at
`input-required` until `{ confirm }`), and follows an order for up to 25 seconds per request.
`CancelTask` cancels the order first, as the caller.

Push notifications (`push.ts`) keep their configs in `push_configs` and a durable outbox in
`push_outbox` in the same SQLite, retried on the object's alarm. Updates that happen with no
request open take a second path: `SqlTaskStore.follow` calls `OrderAgent.watch(<A2AAgent name>)`,
the `OrderAgent` schedules `notifyWatchers` when its status or waits change, and that calls
`A2AAgent.orderChanged(orderId)`, which re-reads each following task and pushes the ones that
changed. See [A2A endpoint](https://docs.orderloop.app/reference/a2a/#push-notifications).

## Bindings

| Binding | Worker | Resource |
|---|---|---|
| `ORDER_AGENT` | engine | Durable Object class `OrderAgent` (SQLite, migration tag `v1`) |
| `ASSISTANT_AGENT` | engine | Durable Object class `AssistantAgent` (SQLite, migration tag `v2`) |
| `A2A_AGENT` | engine | Durable Object class `A2AAgent` (SQLite, migration tag `v3`) |
| `ORDER_LOOP` | engine | Workflow `orderloop-order`, class `OrderLoop`, `limits.steps: 10000` |
| `REPLENISH` | engine | Workflow `orderloop-replenish`, class `Replenish`, schedule `0 6 * * *` |
| `DB` | both | D1 `orderloop`, migrations in `packages/db/migrations` |
| `DOCS` | both | R2 `orderloop-docs` |
| `AI` | engine | Workers AI |
| `ENGINE` | web | Service `orderloop-engine`, entrypoint `EngineApi` |
| `OAUTH_KV` | web | KV namespace for MCP and A2A OAuth clients, grants and tokens; created on first deploy |

Variables and secrets are listed in [Configuration](configuration.md).

## Connectors

`apps/engine/src/connectors.ts` holds mock commerce connectors over the D1 back office
(`customers`, `products`, `contract_prices`, `price_sources`, `price_rules`, `reservations`,
`stock_movements`, `locations`, `location_stock`, `entitlements`, `payments`,
`shipments`, `messages`)
and R2. Each function is the seam where a real adapter (a WMS, a carrier API, an ERP)
replaces the mock. Payments already have one: `apps/engine/src/payments.ts` (re-exported from
`connectors.ts`) records each payment in D1 and, with `PAYMENTS_MODE=stripe`, calls Stripe through
the fetch client in `apps/engine/src/stripe.ts` (form encoding, pinned `Stripe-Version`,
`StripeError`, no SDK and no retries of its own). Card errors take the node's declined or failed
branch; Stripe 5xx, 429, 409 and network errors throw so the step retries; any other refusal is a
`NonRetryableError`. `paymentSource` in `packages/core/src/payments.ts` picks external, offline,
adopt, confirm, off-session or none from `order.payment`, the node's method and the customer's
saved card, and `toMinor`/`fromMinor` (`packages/core/src/money.ts`) convert amounts, with
zero-decimal currencies. `validateAddress` is the seam for an address provider (USPS, Loqate); the mock
calls `checkAddress` from core. `quoteShipping` POSTs to a shipping-rate node's live carriers
(https, 5 seconds, credentials from `SHIPPING_CARRIER_AUTH`) and falls back to the node's
configured services; it and the Stripe calls are the connectors' only outbound requests.

Two rules hold for every connector:

- **Writes are keyed by the step that made them.** Ids embed the order id and the step key, for
  example `res_${orderId}_${stepKey}_${line}_${sku}`, `pay_${orderId}_${stepKey}`,
  `shp_${orderId}_${stepKey}`, and inserts use `onConflictDoNothing`. Every order on a flow shares
  its step keys, so the order id is what keeps two orders apart. A retried step finds its own row
  instead of writing a second one. `refund` returns the refund its step already made, and never
  refunds more than was captured or charged; with Stripe payments it spreads over them newest
  first, one row (`rfd_…`, `rfd_…_1`) and Stripe refund per payment. A Stripe call's
  `Idempotency-Key` is the row id, so a retried step replays Stripe's first answer. Stock changes (`reserveInventory`'s holds and
  `restock`) go through the `stock_movements` ledger, which records each change and applies it to
  `products` (or, with a `location_id`, a store's `location_stock` row) in one batch, once. A hold is written only while the stock is still free. Capture flips its authorization to `captured` and records the capture in one batch, and a retried capture returns the one already recorded.
- **After a continue-as-new, keys gain the generation.** The ids above embed the effect key, `${nodeId}#${run}@g${generation}` from generation 2 on (see [OrderLoop Workflow](workflow.md#step-names)).
- **Compensations are idempotent.** `releaseInventory` releases only `held` reservations (each
  release is a ledger movement, so a cancel racing a rollback releases once),
  `voidAuthorizations` voids only `authorized` payments (a void racing a capture leaves exactly
  one of them; a Stripe one is canceled in Stripe first, and D1 changes only after), `cancelShipment` sets one shipment
  `cancelled`, `revokeEntitlements` revokes only `issued` codes, `restoreShippedStock` restores a `consumed` reservation once, `reverseBalance` reverses a balance entry once. Running one twice changes nothing.

The saga compensations a failed order runs are `ROLLBACKS` in `apps/engine/src/nodes.ts`; a
cancel runs `compensateOrder`, which releases, voids, cancels open shipments and staged pickups, revokes issued digital codes, restocks shipped stock once no shipment is live, reverses on-account charges, cancels seller orders and reverses scheduled payouts in one pass. A node
type with `rollback: true` in the catalog must have a `ROLLBACKS` entry.

To exercise failure paths, set `meta.simulate` on the order input:

| `meta.simulate` | Effect |
|---|---|
| `out_of_stock` | `reserveInventory` reports every line short |
| `payment_decline` | `authorizePayment` records a `declined` authorization (with `PAYMENTS_MODE=stripe` and a test key: confirms with `pm_card_visa_chargeDeclined`) |
| `charge_fail` | `charge` records a `failed` charge (likewise on Stripe) |
| `three_way_mismatch` | `commerce.three_way_match` sees an invoice 10% over the order total |

Documents go to R2 through `storeDocument` at `orders/<orderId>/<kind>/<name>` and are indexed in
the `documents` table (see [Data model](data-model.md#r2-documents)).

## Scheduled replenishment

`Replenish` (`apps/engine/src/replenish.ts`) runs on the `REPLENISH` binding's cron. Its
`scan stock` step lists SKUs where `stock - reserved <= reorder_point`; if there are any, its
`start reorder` step seeds the templates and starts one order on `tpl-reorder` (or
`payload.flowId`) for customer `cus_internal`, with the SKUs in `meta.skus`. The reorder flow's
`ai.forecast` node decides the quantities. The order starts through `startOrderOnce` with the idempotency key `replenish:${instanceId}`, so a retry of the step finishes the order it already wrote. `EngineRpc.runReplenish` creates an instance on demand.

## Where state lives

| State | Owner |
|---|---|
| Live run state of one order (nodes, edges, waits, vars, timeline) | Its `OrderAgent` |
| A person's assistant conversation | Their `AssistantAgent` |
| Durable progress (memoized step results, sleeps, waits) | Its `OrderLoop` instance |
| Order index for lists and filters (`orders` row) | D1, written by the agent's `syncIndex` |
| Flows, versions, approvals, back office, webhook outbox, email intake log | D1 |
| Invoices, POs, inbound documents and raw inbound email | R2 |

## The assistant

`AssistantAgent` (`apps/engine/src/assistant/agent.ts`) is an `AIChatAgent` from
`@cloudflare/ai-chat`, one Durable Object per person (binding `ASSISTANT_AGENT`, migration `v2`).
The panel in the web app talks to it over the proxied `/agents/assistant-agent/*` socket, never
through `EngineRpc`. `onConnect` closes with `4403` unless the proxied principal's id is the
instance name, and keeps the principal. The `@callable()` methods are `attention()`, the data for
the top of the panel, and `preview(tool, input)`, which resolves an action against live data for
its confirm card. Tools are `ASSISTANT_TOOLS` in `packages/core/src/assistant.ts`. Reads run
directly; `decide_approval`, `deliver_event`, `cancel_order`, `publish_flow` and
`run_stock_review` use `needsApproval`, and after the confirm `runAction`
(`apps/engine/src/assistant/data.ts`) re-checks the role and the state and calls the order's
`OrderAgent` (`decide`, `deliver`, `cancel`) or the `REPLENISH` Workflow as `<email> via
assistant`. Every tool re-reads the person's session first (`livePrincipal` in
`apps/engine/src/principal.ts`, shared with `OrderAgent`). `propose_flow_change` drafts a graph
with the copilot and never saves. The model is `workers-ai-provider` over `ASSISTANT_MODEL`, with a
deterministic fallback in `assistant/model.ts`. See [The assistant](https://docs.orderloop.app/guides/assistant/).

The `AssistantAgent` instance is named after the person's user id, which the web app sets from the
session whatever the browser asks for. Everyone signed in with the shared `APP_PASSWORD` shares one
instance (as does open local development).

## AI calls

Every AI node except Assess, and the copilot, go through `runJson` (`apps/engine/src/ai.ts`):
`response_format: json_schema`, temperature `0.2`, `max_tokens` 2048, a 20-second cap
(`AI_TIMEOUT_MS`), and the answer checked with `conforms` (`packages/core/src/json-schema.ts`); a
non-conforming answer is treated like an error. On `AI_MODE=mock`, an error, a timeout or an empty
answer, each node's heuristic runs and the output records `source: "heuristic"`. Extract order and
Summarize send at most the first 20,000 characters.

Assess calls Clef directly (`assess` in `apps/engine/src/clef.ts`, `ASSESS_MODEL`) with the fixed
body `model: "clef"`, `state`, `questions`, `images`; same cap and `AI_MODE` fallback. Answers go through `clampAnswers`
(`packages/core/src/assess.ts`). Images are embedded inside the step: R2 keys under
`orders/<orderId>/` only, `https` URLs, or `data:` URLs.

The copilot (`EngineRpc.copilot`, also used by the assistant's `propose_flow_change`) fills missing
config from catalog defaults, gives edges ids, keeps existing positions and re-runs layout only when
nodes were added, then returns `validateGraph`'s errors and warnings with the graph. Every model
call, the assistant's and Assess's included, goes through AI Gateway when `AI_GATEWAY_ID` is set.
User-facing behaviour: [AI nodes and the assistant](https://docs.orderloop.app/guides/ai/).

## Template seeding

`seedFlows` (`packages/db/src/flows.ts`) publishes each template in `TEMPLATES`
(`packages/core/src/templates.ts`) whose exact JSON has never been published as a version of that
flow: a new template as version 1, a changed one as the next version. It runs:

- in the web app, through `ensureSeeded()` (`apps/web/app/lib/flows.server.ts`), the first time an
  isolate lists or loads flows (dashboard, `/flows`, a flow page, `GET /api/v1/flows`) or starts an
  order (New order form, `POST /api/v1/orders`, signed `POST /api/v1/webhooks/orders`);
- in the engine, through `ensureTemplates()` (`apps/engine/src/flows.ts`), before `Replenish`
  starts a replenishment order.

A template that matches any earlier published version is left alone, so code still running from
before a change can't roll a newer version back, and seeding twice publishes once. The dashboard's
demo scenarios are `SCENARIOS` in `apps/web/app/lib/scenarios.ts`, shown only where `demoAvailable()` finds their customers and SKUs (the demo data in `packages/db/seed`, never in production); the docs page
[Built-in flows](https://docs.orderloop.app/guides/templates/) describes them.

See [OrderLoop Workflow](workflow.md) and [OrderAgent](order-agent.md).
