# Testing

What pnpm test runs in each package, how the engine runs real Workflows in workerd, and where to add a test.

`pnpm test` runs `turbo run test`, which runs `vitest run` in every package that has tests. The
`test` task has no `dependsOn`, so a failing dependency never silently skips a package's tests.
CI runs it after lint, type-check and build, then audits production dependencies
(`.github/workflows/ci.yml`), each step running even when an earlier one failed.

| Package | Environment | Config |
|---|---|---|
| `packages/core` | Node | `packages/core/vitest.config.ts` |
| `packages/design` | Node | `packages/design/vitest.config.ts` |
| `apps/engine` | workerd, through `@cloudflare/vitest-plugin` | `apps/engine/vitest.config.ts` |
| `apps/web` | Node | `apps/web/vitest.config.ts` |

:::caution
vitest is pinned to `5.0.3` in the workspace catalog (`pnpm-workspace.yaml`): 5.0.4's module cache
breaks `@cloudflare/vitest-plugin`. Don't bump it without running the engine suite.
:::

## Core: the planner and pure logic

`packages/core/tests/`:

| File | Covers |
|---|---|
| `graph.test.ts` | Every template validates; the planner's paths (the cheap procurement request skipping approvals, a rejection reaching its end through a join, a B2B order the customer never clarifies ending on its own reason, the dunning loop to its limit and its early exit, the marketplace acceptance loop (all auto-accepted, sellers answering in turn, a timeout with no seller accepting, the loop limit), a mixed omnichannel cart capturing only after both the shipment and the digital delivery, an uncollected pickup ending in `uncollected` without capturing, the point-of-sale flow's receipt emailed only when there is an address, subscription periods with distinct step runs then continue-as-new, a failed retry stopping a subscription, `isSettled`); `validateGraph` (forward cycles, unknown outputs, disconnected nodes, a second trigger, back-edges from outside the body, node config) |
| `assess.test.ts` | Assess questions held to Clef's limits (1–64 questions, 2–255 options, 2–10 score levels); the node's outputs (a choice's options, yes/no for `noul`, `unsure` with a confidence floor, none to branch on for a score); `assessBranch`; `clampAnswers` dropping unknown options, renormalising and recomputing the choice and score; `branchOn` validation through `validateConfig` |
| `address.test.ts` | `checkAddress`: clean addresses pass unchanged; whitespace, country aliases, region names and US, CA and GB postcodes are corrected; unknown fields are dropped; missing fields, unknown regions and countries, bad postcodes and free-text ship-tos are rejected with every issue listed |
| `api.test.ts` | `startFingerprint`: property order is ignored, while version, vars, values and line order change it |
| `a2a.test.ts` | `ORDER_TASK_STATES`: an order status is a finished task state exactly when it is a finished order status; a waiting order's text names each approval (`nodeId`) and event and how to reply; every assistant tool is a skill at its own role and `place_order` needs `operator`; the Agent Card points at the given origin and its OAuth metadata |
| `fulfillment.test.ts` | `shipToPoint` reads coordinates and postal code from an address object only; `distanceKm`; `rankStores` by distance, then postal code, then id, stores without coordinates last; `allocateLines` shipping whole from the first source that has everything, splitting by line nearest first, and reporting short SKUs |
| `lines.test.ts` | `stockLines`: no list restocks every line merged per SKU; listed lines are capped at the ordered quantity; unknown SKUs, bad quantities and non-lists are ignored |
| `inbound.test.ts` | Inbound orders: a channel, external id and lines or a document are required; an exact model and channel route beats a wildcard, then the default template; the start is keyed by channel and external id and keeps ship-to in `meta`; the fingerprint ignores property order and changes with the contents |
| `intake.test.ts` | Email intake: mailbox local parts map to flows (case and `+tag` ignored, bad config falls back); senders match a customer address or company domain, never a webmail domain alone, or an allowlist; a passing DMARC, DKIM or SPF result is required; the document combines body and attachments, capped, with HTML turned to text |
| `channels.test.ts` | Shopify and X12 mapping (`packages/core/tests/fixtures/shopify-order.json`): an `orders/create` payload becomes a valid inbound order; channel from `source_name` and model from `company`; line items without a SKU refused; the HMAC verified; an interchange parsed with the delimiters its ISA declares; an 850 mapped to a `b2b` `edi` order for the partner; several POs split and the `SE` and `CTT` counts checked; an 850 with no PO number, a bad line count or a line without a part number refused |
| `types.test.ts` | `orderInputSchema` requires a model and defaults the channel, and takes a guest contact, fulfillment and a line seller; buy-side models price at cost; every model starts from a template |
| `roles.test.ts` | `atLeast` orders viewer < approver < operator; a principal round-trips through the proxy header, non-ASCII names included; a missing, malformed or unknown-role header is rejected |
| `pricing.test.ts` | `resolvePrice`: list-price fallback; a stopping source ends the chain and an open one lets the lowest candidate win; priority order (price book before contract, and reordered); the deepest volume tier; every scope (SKU, tier, window, a rule with no price); sources left out of the chain |
| `policy.test.ts` | `evaluatePolicy`: every rule, all failures reported together, quantities summed per SKU, business hours in a time zone, PO boxes in string and structured addresses, malformed rules rejected at validation |
| `integrations.test.ts` | Integration scopes: a payment provider delivers its event and nothing else; a channel-bound key reaches only its channel; an order names only the flows the key allows; the previous secret is accepted until it expires; a signature verifies with either secret; `signatureKeyId` reads `k=`; `newWebhookSecret` makes distinct `whsec_` secrets |
| `webhooks.test.ts` | `signWebhook` / `verifyWebhook`: a valid signature, a tampered body, a wrong secret, a missing header, a replay outside the tolerance |

### Adding a planner test

Planner semantics live only in `packages/core/src/graph.ts`, so a planner change comes with a test
in `graph.test.ts`. Its `simulate(graph, choose)` helper drives the planner the way the Workflow
does: it loops `readyNodes` → `beginNode` → complete, calling `choose(id, run)` to pick each node's
branches (or a loop's `next`), and returns `{ ran, state, ended }`, where `ran` lists node ids in
the order they ran.

```ts
it('skips the approval for a small order', () => {
  const { ran, ended } = simulate(tpl('tpl-purchase-request'), (id) =>
    id === 'needs_mgr' ? ['false'] : undefined,
  );
  expect(ran).not.toContain('mgr');
  expect(ended).toBe('done');
});
```

`undefined` from `choose` takes the node's first output (and, for a loop, continues while
`run <= maxIterations`). Check node ids against `packages/core/src/templates.ts` before writing
them into a test.

## Engine: real Workflows in workerd

The engine suite runs the real `OrderAgent` Durable Object and `OrderLoop` and `Replenish`
Workflows against local D1 and R2, from the engine's own `wrangler.jsonc`:

- `remoteBindings: false` and the binding `AI_MODE: 'mock'`, so every AI node, the copilot and the assistant use
  their heuristics. No network or Cloudflare account is needed.
- `TIME_SCALE: '1'`; tests skip waits with `introspectWorkflow(env.ORDER_LOOP)` and
  `modifyAll(m => { m.disableSleeps(); m.disableRetryDelays(); m.forceEventTimeout({ name }) })`,
  forcing named `waitForEvent` steps (by step key, for example `mgr#1`) to time out.
- `tests/setup.ts` applies `packages/db/migrations` (read with `readD1Migrations`, bound as `TEST_MIGRATIONS`) to the test D1, then the demo data in `packages/db/seed` (bound as `TEST_SEED`): the demo customers, catalog, stores and rates the tests order against, which the migrations no longer carry.
- The plugin list includes `agents/vite` so the `@callable()` TC39 decorators are transformed.
- `testTimeout` is 60 seconds.
- A second, empty D1 (`MIGRATION_DB`) lets `tests/migrations.test.ts` apply the migrations up to one and run it against rows in the older shape.

| File | Covers |
|---|---|
| `tests/agent.test.ts` | `OrderAgent.report`: replayed snapshots ignored, timeline keys deduped, a new generation accepted; terminal statuses and rolled-back nodes kept once set |
| `tests/assistant.test.ts` | The assistant's heuristic model reads plain requests into one tool call, never offers a tool the role lacks, links what it finds and treats a malformed page context as the workspace; action previews resolve against live data (decision, cancel effects, events nothing waits for) and refuse roles that can't make them; the `AssistantAgent` socket opens only for its own person, returns `attention()` and `preview()`, and stops when the sign-in ends; a confirmed action records `<email> via assistant` |
| `tests/mcp.test.ts` | `/mcp` refuses a request the web Worker did not forward; `tools/list` offers a viewer 7 tools and an operator 13, with titles, annotations and input schemas; reads return `structuredContent`; `assess_order` answers heuristically and skips another order's image key with a note; a tool the role lacks is unknown; a refusal from live data is a tool error; an approver's decision is recorded as `<email> via MCP` |
| `tests/a2a.test.ts` | `/a2a` on the engine: the card parses as A2A 1.0; a request the web Worker did not forward is `401` and an unsupported `A2A-Version` an error; a typed skill runs as the caller within their role; each caller sees only their own tasks; `place_order` is once per message id and the task follows the order to its approval; cancelling the task cancels the order; refusals from live data end the task; chat proposes an action and runs it only on `{ confirm: true }`; `SendStreamingMessage` streams status updates over SSE; push notifications (`A2A push notifications`): a registered URL gets the task's updates with the token header and `application/a2a+json`, including after the request ended (an approval decided on the order page), without back-to-back repeats; the config methods create, list and delete, and an `http` URL is refused; configured `authentication` becomes the `Authorization` header and a failing receiver is retried on the alarm until the outbox is empty; 0.3 clients (`A2A 0.3 clients`): 0.3 method names answer in 0.3 shapes on shared tasks, an order is followed and a 0.3 streamed reply decides it, a URL registered over 0.3 gets the whole task as its push, and a push table made before 0.3 support gains its wire-version column |
| `tests/docs-sample-run.test.ts` | Each run the docs home page draws (`apps/docs/src/data/runs/*.json`: a pickup in store and a B2B purchase order) is still the run the engine produces on its recorded input: same nodes, statuses, branches, summaries and totals |
| `tests/email.test.ts` | Email intake through the `email()` entrypoint: a customer PO with a CSV attachment becomes one B2B order (a replay is a duplicate); unknown senders and mailboxes and unauthenticated mail are rejected and logged; an allowlisted sender is accepted and `purchasing@` routes to a purchase request |
| `tests/flows.test.ts` | Template seeding: every template is published once (a second `ensureTemplates` adds no version); a changed template becomes the next version over edits published since; a template matching an earlier version is left alone, so older code can't roll it back; publishing races (three concurrent `publishFlow` calls get versions 1 to 3, and three concurrent seeds of one template leave one version) |
| `tests/retention.test.ts` | The daily `sweep`: deletes what is past its retention and keeps the rest |
| `tests/migrations.test.ts` | `0018_order_models` against an older database: flows, published versions, orders and node runs move to a model and a channel; `0027_remove_demo_data`: the demo catalog, customers (all but `cus_internal`) and rates (all but `USD`), sellers and stores go, as do orders placed against demo customers or SKUs with their rows (reservations, balance entries, node runs), while other orders and the three price sources stay |
| `tests/orders.test.ts` | End-to-end orders on every template: B2B extraction, auto-approval, shipping and payment; credit-limit approval and decline, and an approval nobody decides in time ending on its own reason; the dunning loop, with a timed `node_runs` row per run of each step and wait; out-of-stock failure and rollback; cancel releasing everything; subscription retries; reorder forecast and restock; storefront ship, capture, return and partial refund; restocking only a partial return's lines; per-order reservations and the stock ledger under retries; two orders racing for the last units (one is short); a cancel racing a rollback and a shipment releasing a hold once; a retried capture returning the same payment; a capture and a void racing (exactly one wins); a continue-as-new flow charging again in the next generation although its step names repeat; policy cancel; return window closing; idempotent capped refunds; an inbound order's retry matching after its route changes and refused with different contents; the engine RPC reporting an unknown order, a step not waiting and an order already finished; a marketplace order waiting on one seller, paying both out net of commission, capturing only what a partial acceptance kept, failing and voiding when no seller answers, and cancelling seller orders on a later failure; a guest checkout emailing the contact address; guests and consumers taking a credit check's no-account branch; only unpaid business invoices billed on account; `Idempotency-Key` races, half-started replays and fingerprint mismatches; outbound webhook signing, retry and give-up; `order.cancelled` and `order.failed`; address validation branching on a published test flow; the pricing chain against the seeded sources (price book, contract, volume and list per customer, per-node switches, given prices, reordering and turning off sources); pricing in EUR at the stored rate, given prices left alone and an unknown currency rejected; credit checked in USD for a GBP order; the agent socket refusing a viewer's decide and cancel and a socket without a principal, and recording an approver's own email as `by`; an open socket following a role change, a disabled user, a signed-out session and a forged session id; an idle session refused and socket calls recording activity; the offline copilot; Assess: branching on the chosen option and storing every answer, `unsure` below the confidence floor, and `resolveImages` accepting only the order's own R2 keys, https and data URLs; omnichannel and point of sale: a pickup holding the store's stock with a six-character code then handing it over on `pickup.collected`, an uncollected pickup releasing the store's stock, cancelling the pickup and voiding payment, ship-from-store with an e-book code and one capture for the full total, shipping from the store nearest the ship-to, a split shipment across the warehouse and the nearest store with one shipment per source, codes revoked when the physical part can't be fulfilled, and a till sale from the store's stock with an emailed receipt; orders mapped from Shopify (the payload's price kept) and from an X12 850 (a B2B order for the partner's customer) running their flows |

Tests drive orders through `startOrder`, then poll the agent's `snapshot()` until a predicate holds
(`until`, `waitingOn`, `settled`), and assert on D1 rows (`payments`, `reservations`, `location_stock`, `entitlements`, `shipments`,
`approvals`, `webhook_deliveries`) as well as state.

## Design

`packages/design/tests/tokens.test.ts` holds the Ledger tokens in `packages/design/src/tokens.ts` to
`apps/web/app/app.css`, value for value in both schemes, plus the font stacks, and fails when the
generated `apps/docs/src/styles/theme.css` is stale. Fix it by mirroring the `app.css` change in
`tokens.ts` and running `pnpm sync:theme`.

## Web

`apps/web/tests/`:

| File | Covers |
|---|---|
| `api.test.ts` | REST order actions against a mocked engine (also the order-list cursor round trip, and `400` for a cursor the API did not issue): an unknown order is `404`, deciding a node that isn't waiting and cancelling a finished order are `409`, and an event nothing waits for is `200` with `delivered: false`. Signed events: a signature that names no integration, an unknown one or the wrong secret is `401`; a key is held to its events and, if channel-bound, to its channel's orders (`403`, and `404` for an order it can't see). Integrations over REST: create shows the secret once and records who did, rotate and revoke, `404` for an unknown key, operator only |
| `openapi.test.ts` | The OpenAPI document serialises, request bodies come from the zod schemas (every content type of each), the Shopify route is unauthenticated and the EDI route is not, every outbound event is listed, signed inbound events are unauthenticated; subscription URLs require https except on localhost and default to every event |
| `credentials.test.ts` | PBKDF2 hashes verify only the right password and use a fresh salt; malformed or out-of-range hashes fail; `ol_live_` tokens are stored as SHA-256 with a 12-character prefix; generated passwords, email normalisation, `safeEqual`; the password policy |
| `throttle.test.ts` | Sign-in keys (email and address, address, email; the workspace password as one email); a key blocks at its limit until its window ends, old windows don't count, each kind has its own limit and the longest wait wins; waits round up to whole minutes |
| `origin.test.ts` | `crossOrigin`: reads pass from anywhere; writes from another origin, a sibling subdomain, `null` or plain http are refused; the WebSocket handshake is checked although it is a `GET`; the `Sec-Fetch-Site` fallback; clients with neither header pass |
| `ago.test.ts` | `Ago` server-renders a machine-readable time with the UTC time as its tooltip, and a dash without a time |
| `inbound.test.ts` | `POST /api/v1/webhooks/orders`: starts the routed flow once per channel and external id, with a payload fingerprint; `ORDER_ROUTES` is used and an unpublished flow refused; a bad signature, a bad body and an unknown currency are refused; each integration is held to its scope (`startOrders`, channel, `flows`) with `403` |
| `channels.test.ts` | The channel routes: a Shopify order starts once for the customer matching its email; a bad signature is refused, other topics ignored and unmappable orders reported; an 850 interchange starts one order per PO for the partner's customer; unknown partners, bad X12 and callers below `operator` are refused |
| `totp.test.ts` | Base32 round-trips; TOTP matches the RFC 6238 vectors, accepts one step of drift either way, refuses a step already used, takes spaces and dashes in a typed code and builds the `otpauth` URI; recovery codes are ten distinct, readable codes that hash ignoring case, spaces and the dash |
| `two-factor.test.ts` | The `two_factor_required` setting covers the chosen role and above, accepts only known values and is described in the audit log |
| `audit.test.ts` | Audit events described in one line (role changes as from → to, token roles, failure reasons); every action belongs to a filter group, including `integration` |
| `tokens.test.ts` | API token lifetimes: 30 days, 1 year and never; token state active, expiring within 14 days, expired at its expiry time, revoked first |
| `sessions.test.ts` | `describeAgent` names browser and system (Chrome, Edge, Safari on iOS, Firefox on Linux, curl, unknown); `sessionRef` |
| `mcp.test.ts` | `/mcp` and `/a2a` on the web Worker, with auth and the engine mocked: only MCP, A2A and OAuth protocol paths go to the provider (not `/oauth/authorize`); one authorization server advertises both resources; `/a2a` challenges with its own resource metadata and forwards a token caller; an OAuth token is bound to the endpoint it was granted for; a request without a token gets `401` pointing at the resource metadata; an API token caller is forwarded without its credential and with the principal header; unknown tokens `401`, throttling `429` with `Retry-After`, expiry `401`; a caller still on a temporary password or owing two-factor setup `403`; a malformed `Origin` `403`. `vitest.config.ts` inlines `@cloudflare/workers-oauth-provider` so the `cloudflare:workers` mock applies |
| `approvals.test.ts` | Approval context for a credit check: the order in its own currency with its USD equivalent, and limits, balances and the shortfall in USD |
| `scenarios.test.ts` | Every demo scenario targets a valid seeded flow of its model; money, relative time, UTC date and duration formatting; status-to-token mapping |

## What isn't covered

The flow editor canvas and the live order page are not under test; verify UI changes by running
`pnpm web:dev` and driving a scenario. See [Getting started](local-development.md).
