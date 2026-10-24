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
| `apps/engine` | workerd, through `@cloudflare/vitest-plugin`; three projects, `engine`, `plugins` and `stripe` | `apps/engine/vitest.config.ts` |
| `apps/catalog` | workerd, through `@cloudflare/vitest-plugin` | `apps/catalog/vitest.config.ts` |
| `apps/catalog-edge` | workerd, through `@cloudflare/vitest-plugin` | `apps/catalog-edge/vitest.config.ts` |
| `apps/web` | Node | `apps/web/vitest.config.ts` |

:::caution
vitest is pinned to `5.0.3` in the workspace catalog (`pnpm-workspace.yaml`): 5.0.4's module cache
breaks `@cloudflare/vitest-plugin`. Don't bump it without running the engine and catalog suites.
:::

## Core: the planner and pure logic

`packages/core/tests/`:

| File | Covers |
|---|---|
| `graph.test.ts` | Every template validates; the planner's paths (the cheap procurement request skipping approvals, a rejection reaching its end through a join, a B2B order the customer never clarifies ending on its own reason, the dunning loop to its limit and its early exit, the marketplace acceptance loop (all auto-accepted, sellers answering in turn, a timeout with no seller accepting, the loop limit), a mixed omnichannel cart capturing only after both the shipment and the digital delivery, an uncollected pickup ending in `uncollected` without capturing, the point-of-sale flow's receipt emailed only when there is an address, subscription periods with distinct step runs then continue-as-new, a failed retry stopping a subscription, `isSettled`); `validateGraph` (forward cycles, unknown outputs, disconnected nodes, a second trigger, back-edges from outside the body, node config) |
| `provenance.test.ts` | Each AI prompt has a version and `promptId` names it (`router@1`); the assistant budget is a million tokens a day unless set, `0` is no limit, and a bad value is the default |
| `assess.test.ts` | Assess questions held to Clef's limits (1–64 questions, 2–255 options, 2–10 score levels); the node's outputs (a choice's options, yes/no for `noul`, `unsure` with a confidence floor, none to branch on for a score); `assessBranch`; `clampAnswers` dropping unknown options, renormalising and recomputing the choice and score; `branchOn` validation through `validateConfig` |
| `address.test.ts` | `checkAddress`: clean addresses pass unchanged; whitespace, country aliases, region names and US, CA and GB postcodes are corrected; unknown fields are dropped; missing fields, unknown regions and countries, bad postcodes and free-text ship-tos are rejected with every issue listed |
| `encryption.test.ts` | `encryptSecret` / `decryptSecret`: a value reads back under the current key with a fresh IV each time; one moved to another row (different context) or altered is refused; values under the previous key read during a rotation and not after; a value without the `e1.` prefix passes through; no key to encrypt with throws |
| `erasure.test.ts` | Data subject matching and erasure: the email is trimmed and lower-cased; terms are longest first and under 3 characters skipped; `eraseOrderState` removes contact, document text and personal `meta`, replaces the subject's names and masks emails and phones through the state, and keeps lines, amounts and statuses; `personalDataRetentionDays` keeps data when unset or zero and never goes under 30 |
| `api.test.ts` | `startFingerprint`: property order is ignored, while version, vars, values and line order change it |
| `a2a.test.ts` | `ORDER_TASK_STATES`: an order status is a finished task state exactly when it is a finished order status; a waiting order's text names each approval (`nodeId`) and event and how to reply; every assistant tool is a skill at its own role and `place_order` needs `operator`; the Agent Card points at the given origin and its OAuth metadata |
| `checkout.test.ts` | The checkout session (`checkout.ts`): `applyLines` numbers new lines `li_1`… and keeps the ids it is given back; `patchCheckout` replaces only what the patch names; `missingInfo` and `openStatus` (a digital order needs lines and an email; goods that ship also need an address and an option unless the flow picked one; an error only a person can clear escalates, warnings are ignored); `isOpenCheckout` and `isExpired`; `quoteNodes` takes the pricing and policy nodes in the order the flow reaches them and ignores loop back-edges; `checkoutFlowProblem` refuses a flow that never holds a card payment |
| `ucp.test.ts` | UCP (`ucp/`), validated against the official JSON schemas vendored in `tests/fixtures/ucp` (checked by `@cfworker/json-schema`; Biome ignores the folder): the business profile, checkouts (incomplete, ready and completed, with fulfillment, in minor units) and orders, error responses and requests the schema refuses; `UCP-Agent` and structured fields (RFC 8941); a webhook signed with `signMessage` verifies with the published key and fails once altered (RFC 9421, ES256, `Content-Digest`); negotiation activates what both sides list, prunes an orphaned extension and refuses a newer protocol or an empty intersection; settings fall back to off; ship-to kept by id on update; shipments become order events and refunds negative adjustments; an order that ended unfulfilled removes every line |
| `fulfillment.test.ts` | `shipToPoint` reads coordinates and postal code from an address object only; `distanceKm`; `rankStores` by distance, then postal code, then id, stores without coordinates last; `allocateLines` shipping whole from the first source that has everything, splitting by line nearest first, and reporting short SKUs |
| `untrusted.test.ts` | Prompt-injection guards: a `dataBlock` can't be closed or reopened from inside its content and writes non-strings as JSON; `boundExtractedLines` keeps catalog SKUs with whole quantities, adds up repeats and holds back unknown SKUs, fractions, zero, negatives, non-numbers, totals over `MAX_EXTRACTED_QTY` and lines past `MAX_EXTRACTED_LINES`; `boundText` strips control characters and cuts; `clampNumber` clamps or falls back |
| `lines.test.ts` | `stockLines`: no list restocks every line merged per SKU; listed lines are capped at the ordered quantity; unknown SKUs, bad quantities and non-lists are ignored |
| `inbound.test.ts` | Inbound orders: a channel, external id and lines or a document are required; an exact model and channel route beats a wildcard, then the default template; the start is keyed by channel and external id and keeps ship-to in `meta`; the fingerprint ignores property order and changes with the contents |
| `intake.test.ts` | Email intake: mailbox local parts map to flows (case and `+tag` ignored, bad config falls back); senders match a customer address or company domain, never a webmail domain alone, or an allowlist; a passing DMARC, DKIM or SPF result is required; the document combines body and attachments, capped, with HTML turned to text |
| `channels.test.ts` | Shopify and X12 mapping (`packages/core/tests/fixtures/shopify-order.json`): an `orders/create` payload becomes a valid inbound order; channel from `source_name` and model from `company`; line items without a SKU refused; the HMAC verified; an interchange parsed with the delimiters its ISA declares; an 850 mapped to a `b2b` `edi` order for the partner; several POs split and the `SE` and `CTT` counts checked; an 850 with no PO number, a bad line count or a line without a part number refused; a Shopify order carries `payment.provider` `external` |
| `types.test.ts` | `orderInputSchema` requires a model and defaults the channel, and takes a guest contact, fulfillment and a line seller; buy-side models price at cost; every model starts from a template |
| `roles.test.ts` | `atLeast` orders viewer < approver < operator < admin; a principal round-trips through the signed proxy header for its path, non-ASCII names and session included; another key, another path, an expired or tampered header is refused, the previous key is accepted during a rotation, and a missing, malformed, unsigned or role-less header is rejected; separation of duties: `ownOrderRefusal` refuses only with the setting on and a known starter equal to the decider |
| `payments.test.ts` | `toMinor`/`fromMinor`: cents, zero-decimal currencies (`JPY`, `KRW`), rounding and round trips; the `paymentSource` matrix (external, offline methods, adopt over confirm, a saved card only with a customer, none); `order.payment` accepts only Stripe-shaped ids and known providers |
| `pricing.test.ts` | `resolvePrice`: list-price fallback; a stopping source ends the chain and an open one lets the lowest candidate win; priority order (price book before contract, and reordered); the deepest volume tier; every scope (SKU, tier, window, a rule with no price); sources left out of the chain |
| `shipping.test.ts` | `shippingConfigSchema` defaults and its refusals (http live carriers, inverted delivery windows, no services); the shipping-rate node's default config validates; `staticRates` (base plus per item, the international multiplier, no country as domestic); `rateOptions` cheapest first with the free threshold on the cheapest, live quotes preferred; `parseCarrierQuote` prefixing ids and dropping bad options; `pickOption` for `from_order`, `cheapest` and `fastest`; `shipToCountry` normalising aliases |
| `totals.test.ts` | `computeTotals`: shipping added and taxed only when the tax node says so; no tax before a tax node; the rate kept when lines change; `baseTotal` at the order's rate |
| `policy.test.ts` | `evaluatePolicy`: every rule, all failures reported together, quantities summed per SKU, business hours in a time zone, PO boxes in string and structured addresses, malformed rules rejected at validation |
| `integrations.test.ts` | Integration scopes: a payment provider delivers its event and nothing else; a channel-bound key reaches only its channel; an order names only the flows the key allows; the previous secret is accepted until it expires; a signature verifies with either secret; `signatureKeyId` reads `k=`; `newWebhookSecret` makes distinct `whsec_` secrets |
| `webhooks.test.ts` | `signWebhook` / `verifyWebhook`: a valid signature, a tampered body, a wrong secret, a missing header, a replay outside the tolerance; several `v1` signatures (any one passes, in either order); `constantTimeEqual`; `verifyStripeSignature` on a header in Stripe's shape (two `v1`s during a secret roll and a `v0`) |
| `product-routing.test.ts` | The catalog's frozen layout: FNV-1a 64 against the published vectors and a BigInt reference for UTF-8; golden shard, alias-shard and search-shard numbers for fixed keys (never update them: a change strands stored products); 64 and 16 shards; even spread; `productUid` packing into 32 bits and refusing to overflow; `canonicalJson` and `contentHash` ignoring key order and seeing any change |
| `product-model.test.ts` | Product types refused when they can't be indexed or told apart (enum without values, localized non-text, sorting non-numbers, duplicate codes, json filters, bad variant axes); `typeChangeIssues` allowing only additions; `validateProduct` pinning the type version, defaulting the primary category and naming each bad attribute, duplicate SKU, repeated or missing variant options, bad slug and unknown type; `productAliases`; `renderForChannel` resolving locales with fallback, enum labels, channel and variant prices, cards, search text and the index entry, and publishing nothing for drafts or unlisted products (fixture: `tests/fixtures/product.ts`) |
| `product-listing.test.ts` | The binary listing index against a brute-force oracle on 3,000 pseudo-random products: dense (bitset) and sparse (list) term filters, ranges, both price sorts, disjunctive facet counts; cursor paging to the last page; range buckets with min and max; an unknown sort and foreign bytes refused; an empty category; `listingSpec` (terms, numbers, sorts, buckets and per-locale labels from the types) and a built index keeping `buckets` and `labels` and counting the stored buckets by default |
| `product-search.test.ts` | `normalizeQuery` folding case, width (NFKC) and spacing and capping at `QUERY_MAX`; `ftsQuery` quoting every term and prefix-matching only the last; FTS5 syntax (operators, column filters, quotes) coming out as plain quoted terms |
| `product-feed.test.ts` | Streaming CSV records (quotes, `""`, newlines inside fields, CRLF, BOM, UTF-8 split across chunks, an unterminated quote, bytes that aren't UTF-8 failing) and NDJSON lines (bad lines reported by number); each record's `end` offset as a cursor: a ranged read from the `end` of any record yields exactly the records after it, at the same offsets, for CSV and NDJSON; CSV rows grouped into products with cells read by attribute kind and channel prices in minor units; a bad row reported against its product while later rows still parse; resuming mid-file from a product boundary with the saved header gives the rest of the products; `key` and `sku` columns required |

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
- A third (`DEMO_DB`) and `packages/db/reset` (bound as `TEST_DEMO_RESET`) let `tests/demo-reset.test.ts` run the demo's nightly reset without touching the database the other tests share.
- Three vitest projects share that setup. `engine` runs `tests/*.test.ts` with payments in the
  default `mock` mode, where `meta.simulate` drives declines, and no plugins installed. `plugins` runs `tests/plugins/**` with the example plugin (`plugins/example`) bound as the auxiliary Worker `orderloop-plugin-example` and service binding `PLUGIN_EXAMPLE` (built from source by `plugins/example/test-worker.ts` with esbuild, with `PRINCIPAL_KEY` `test-principal-key`), its own D1 `EXAMPLE_DB` and `TEST_EXAMPLE_MIGRATIONS`; run it with `pnpm --filter @orderloop/engine exec vitest run --project plugins`. `stripe` runs `tests/stripe/**` with
  the bindings `PAYMENTS_MODE: 'stripe'` and `STRIPE_SECRET_KEY: 'sk_test_fake'`, against the
  in-memory Stripe in `tests/stripe-fake.ts`: `installStripeFake()` spies on `globalThis.fetch`
  (other hosts reach the real fetch) and models PaymentIntents (manual capture, cancel,
  off-session), refunds against what was received, customers, invoices (a draft, items attached by
  `invoice=in_…` or left pending, finalize, send, void, delete a draft; `payInvoice` pays one and
  returns its `invoice.paid` event), `card_declined` for any
  `…chargeDeclined` payment method, and idempotency keys (a repeat replays the first response, a
  different body under one key is refused). `loseNextResponse` carries a request out and drops the
  answer; `failNext` answers 500 untouched. Run one with `pnpm --filter @orderloop/engine exec vitest run --project stripe`.

| File | Covers |
|---|---|
| `tests/agent.test.ts` | `OrderAgent.report`: replayed snapshots ignored, timeline keys deduped, a new generation accepted; terminal statuses and rolled-back nodes kept once set |
| `tests/assistant.test.ts` | The assistant's heuristic model reads plain requests into one tool call, never offers a tool the role lacks, links what it finds and treats a malformed page context as the workspace; action previews resolve against live data (decision, cancel effects, events nothing waits for) and refuse roles that can't make them; the `AssistantAgent` socket opens only for its own person, returns `attention()` and `preview()`, and stops when the sign-in ends; a confirmed action records `<email> via assistant`; a decision through the assistant and a cancel through MCP each write one `audit_events` row with `via` and `tool` |
| `tests/principal.test.ts` | `/mcp` and `/a2a` refuse an unsigned, forged, expired or other-path principal header (`tests/principal.ts` `signed(p, path)` signs with the test binding `PRINCIPAL_KEY`); `livePrincipal` drops an API token once revoked or expired and follows its role, and ends open local dev once a user exists |
| `tests/mcp.test.ts` | `/mcp` refuses a request the web Worker did not forward; `tools/list` offers a viewer 7 tools and an operator 13, with titles, annotations and input schemas; reads return `structuredContent`; `assess_order` answers heuristically and skips another order's image key with a note; a tool the role lacks is unknown; a refusal from live data is a tool error; an action's first call returns a preview and a `cfm_` code and changes nothing; a code is refused for another person, another input or an unknown value, works once, and the decision is then recorded as `<email> via MCP` |
| `tests/injection.test.ts` | Prompt injection against a stub model that records what it is sent: extract, risk, classify, router and summarize put the attack text only in data blocks under `DATA_RULES` that it can't close; the router's author instructions follow the fixed rules and are cut to length; a manipulated answer is held to its bounds (catalog SKUs and quantities, score 0–100, confidence 0–1, text lengths), and an off-list route falls back to the heuristic |
| `tests/confirmations.test.ts` | Confirmation codes: a code is refused at `CONFIRMATION_TTL_MS`, accepted with the input's keys in another order, refused for another tool, and `pruneConfirmations` drops codes a day after they expire (single use and the other-person case are in `mcp.test.ts`) |
| `tests/a2a.test.ts` | `/a2a` on the engine: the card parses as A2A 1.0; a request the web Worker did not forward is `401` and an unsupported `A2A-Version` an error; a typed skill runs as the caller within their role; each caller sees only their own tasks; `place_order` is once per message id and the task follows the order to its approval; cancelling the task cancels the order; refusals from live data end the task; chat proposes an action and runs it only on `{ confirm: true }`; `SendStreamingMessage` streams status updates over SSE; push notifications (`A2A push notifications`): a registered URL gets the task's updates with the token header and `application/a2a+json`, including after the request ended (an approval decided on the order page), without back-to-back repeats; the config methods create, list and delete, and an `http` URL is refused; configured `authentication` becomes the `Authorization` header and a failing receiver is retried on the alarm until the outbox is empty; 0.3 clients (`A2A 0.3 clients`): 0.3 method names answer in 0.3 shapes on shared tasks, an order is followed and a 0.3 streamed reply decides it, a URL registered over 0.3 gets the whole task as its push, and a push table made before 0.3 support gains its wire-version column |
| `tests/ucp.test.ts` | UCP on the engine, with the platform's header signed by `signPlatform` (`tests/ucp-helpers.ts` registers a platform, its profile and the checkout flow, and fakes the platform's profile fetch and webhook receiver): the profile carries the signing key and the test handler; a request without the platform header, or with a principal header, is refused, and a platform header is refused at `/mcp` and `/a2a`; a checkout is priced by the storefront flow's nodes and ready; missing information and store policy are reported; nothing sold is an error response; one platform can't read another's checkouts; update replaces; complete needs an `Idempotency-Key`, replays it and refuses it for another body; cancel works once; a platform on a newer version is refused; completion places the order, the order adopts the payment, and the platform receives signed full snapshots as it ships (digest, signature and `Webhook-Id` checked); the MCP binding lists its tools, returns the UCP body in `structuredContent` and refuses another profile in `meta` and a complete without a key |
| `tests/docs-sample-run.test.ts` | Each run the docs home page draws (`apps/docs/src/data/runs/*.json`: a pickup in store and a B2B purchase order) is still the run the engine produces on its recorded input: same nodes, statuses, branches, summaries and totals |
| `tests/email.test.ts` | Email intake through the `email()` entrypoint: a customer PO with a CSV attachment becomes one B2B order (a replay is a duplicate); unknown senders and mailboxes and unauthenticated mail are rejected and logged; an allowlisted sender is accepted and `purchasing@` routes to a purchase request |
| `tests/flows.test.ts` | Template seeding: every template is published once (a second `ensureTemplates` adds no version); a changed template becomes the next version over edits published since; a template matching an earlier version is left alone, so older code can't roll it back; publishing races (three concurrent `publishFlow` calls get versions 1 to 3, and three concurrent seeds of one template leave one version) |
| `tests/demo-reset.test.ts` | The demo's nightly reset (`packages/db/reset/demo.sql`) removes visitors' orders, flows and audit events and the demo visitor's sessions, keeps people, other sessions, `cus_internal`, `USD` and the price sources, and the demo data loads again to the same counts |
| `tests/subjects.test.ts` | `exportDataSubject` finds a person by account, guest email and intake sender (case and spacing ignored) and leaves others out; `eraseDataSubject` erases their orders' agent state, documents in R2, messages, intake log and the unlinked `.eml`, sets `orders.erased_at`, turns the account into "Erased customer", and finds nothing on a second run; it refuses with `active_orders` while an order runs; `expirePersonalData` erases the buyer only from orders finished longer ago than `PERSONAL_DATA_RETENTION_DAYS` (nothing when empty) |
| `tests/usage.test.ts` | The assistant's daily token budget: a day's turns add up, a turn is refused once the limit is spent, the next UTC day starts again, `0` is no limit, and `pruneUsage` drops days older than 90. `tests/orders.test.ts` also checks a step's output records `source`, `model`, `prompt` and `fallback` (`mock`) |
| `tests/secrets.test.ts` | Webhook secrets at rest: a delivery is signed with the new and the previous secret while a rotation lasts and with the new one alone after; a secret no key opens fails that delivery, not the step. `resealSecrets` encrypts plaintext and moves values from `DATA_KEY_PREVIOUS` onto `DATA_KEY`, counting what it can't open as `unreadable`. The engine tests bind `DATA_KEY: 'test-data-key'` (`vitest.config.ts`) |
| `tests/retention.test.ts` | The daily `sweep`: deletes what is past its retention and keeps the rest (`payment_events` after 30 days included) |
| `tests/stripe/invoices.test.ts` | Invoices through Stripe and Stripe events: the call order (customer, draft with `send_invoice`, `pending_invoice_items_behavior=exclude` and `auto_advance=false`, one item per line, shipping and tax each with `invoice=in_…`, finalize, send) with every write keyed and a retry making no second invoice; a lost finalize finished on retry, and `due_on_receipt` sent as a `due_date` a day out; `voidInvoices` voids an open invoice and leaves one Stripe reports paid; `invoice.paid` before the wait answers `retry` but settles, then resumes `payment.received` once the wait opens, a third delivery is a duplicate, and the balance comes back once; unknown invoices, intents and event types are ignored; `payment_intent.canceled` voids the authorization; a failed order voids its invoice and reverses the charge; a cancel voids an unpaid invoice and leaves a paid one with its settlement |
| `tests/stripe/payments.test.ts` | Payments through Stripe: form encoding of nested parameters; a hold for the total in minor units with the pinned `Stripe-Version`, the key and the row id as `Idempotency-Key`, then a capture, a retried capture doing nothing; a lost response retried into one PaymentIntent; a 500 thrown and nothing recorded; a decline's code recorded on the declined branch; adopting a PaymentIntent, and declining one for another order, amount or currency; external and till payments recorded without a call; no key failing for good; a void that fails leaving the row `authorized`, an already-canceled intent counted, a captured one left to the capture; `verify` creating the Stripe customer once, saving the card and releasing the hold, then an off-session charge; a declined charge; a refund spread over two charges newest first, retried without new refunds; and orders on the built-in flows: a marketplace partial capture, the hold canceled by an agent cancel and by a rollback, a storefront decline, and a subscription that verifies and charges renewals off-session |
| `tests/stripe/ucp.test.ts` | Agentic checkout against Stripe (`PAYMENTS_MODE` `stripe`): the Stripe handler is offered with the publishable key and the test handler is not; completion holds the quoted total with manual capture and the order adopts and captures that hold; a declined card is reported on the checkout and places no order; a credential that isn't a `pm_…` PaymentMethod is refused without calling Stripe |
| `tests/migrations.test.ts` | `0018_order_models` against an older database: flows, published versions, orders and node runs move to a model and a channel; `0027_remove_demo_data`: the demo catalog, customers (all but `cus_internal`) and rates (all but `USD`), sellers and stores go, as do orders placed against demo customers or SKUs with their rows (reservations, balance entries, node runs), while other orders and the three price sources stay; `0030_stripe_payments`: existing payments read as `provider` `mock` with no external id, and two accounts can't share a `stripe_customer_id`; `0031_invoices_payment_events`: existing payments and balance entries untouched, one invoice row per Stripe invoice (`external_id` unique, null allowed more than once), and an event id recorded once |
| `tests/plugin-removed.test.ts` | With no plugin bound (the `engine` project): the catalog and usage are empty, a flow with a plugin node is invalid (`Plugin “example” is not installed`), an order reaching one fails at it and rolls back the steps before it, and `pluginUsage` still reports the published flows that use it |
| `tests/namespaces.test.ts` | Engine source reaches the `ORDER_AGENT`, `ASSISTANT_AGENT` and `A2A_AGENT` namespaces (and `routeAgentRequest`) only through `src/namespaces.ts`, so the jurisdiction always applies (it scans the sources as text); with a stand-in namespace, `orderAgent` asks for the jurisdiction when `DATA_JURISDICTION` is set, not when it is empty, and throws on an unknown value. `scripts/fleet.test.ts` covers the rendering: `DATA_JURISDICTION` follows the registry's `jurisdiction` |
| `tests/orders.test.ts` | End-to-end orders on every template: B2B extraction, auto-approval, shipping and payment; credit-limit approval and decline, and an approval nobody decides in time ending on its own reason; the dunning loop, with a timed `node_runs` row per run of each step and wait; out-of-stock failure and rollback, and `meta.simulate` dropped on a deployment that doesn't allow simulated failures; cancel releasing everything; subscription retries (the card verified, not held); reorder forecast and restock; storefront ship, capture, return and partial refund; storefront shipping charged at the cheapest option and taxed, a chosen option charged abroad and booked with its carrier, and an option that isn't offered declining the order; restocking only a partial return's lines; per-order reservations and the stock ledger under retries; two orders racing for the last units (one is short); a cancel racing a rollback and a shipment releasing a hold once; a retried capture returning the same payment; a capture and a void racing (exactly one wins); a continue-as-new flow charging again in the next generation although its step names repeat; policy cancel; return window closing; idempotent capped refunds; an inbound order's retry matching after its route changes and refused with different contents; the engine RPC reporting an unknown order, `startedBy` recorded and, once the workspace separates duties, neither the RPC nor the agent letting the starter decide while another person can, a step not waiting and an order already finished; a marketplace order waiting on one seller, paying both out net of commission, capturing only what a partial acceptance kept (shipping kept and tax re-applied at the tax node's rate), failing and voiding when no seller answers, and cancelling seller orders on a later failure; a guest checkout emailing the contact address; guests and consumers taking a credit check's no-account branch; only unpaid business invoices billed on account; `Idempotency-Key` races, half-started replays and fingerprint mismatches; outbound webhook signing, retry and give-up; `order.cancelled` and `order.failed`; address validation branching on a published test flow; the pricing chain against the seeded sources (price book, contract, volume and list per customer, per-node switches, given prices, reordering and turning off sources); pricing in EUR at the stored rate, given prices left alone and an unknown currency rejected; credit checked in USD for a GBP order; the agent socket refusing a viewer's decide and cancel and a socket without a principal, and recording an approver's own email as `by`; an open socket following a role change, a disabled user, a signed-out session and a forged session id; an idle session refused and socket calls recording activity; the offline copilot; Assess: branching on the chosen option and storing every answer, `unsure` below the confidence floor, and `resolveImages` accepting only the order's own R2 keys, https and data URLs; omnichannel and point of sale: a pickup holding the store's stock with a six-character code then handing it over on `pickup.collected`, an uncollected pickup releasing the store's stock, cancelling the pickup and voiding payment, ship-from-store with an e-book code and one capture for the full total, shipping from the store nearest the ship-to, a split shipment across the warehouse and the nearest store with one shipment per source, codes revoked when the physical part can't be fulfilled, and a till sale from the store's stock with an emailed receipt; orders mapped from Shopify (the payload's price kept) and from an X12 850 (a B2B order for the partner's customer) running their flows |

Tests drive orders through `startOrder`, then poll the agent's `snapshot()` until a predicate holds
(`until`, `waitingOn`, `settled`), and assert on D1 rows (`payments`, `reservations`, `location_stock`, `entitlements`, `shipments`,
`approvals`, `webhook_deliveries`) as well as state.

### Plugins

`tests/plugins/example.test.ts` (the `plugins` project, helpers in `tests/plugin-helpers.ts`) runs the example plugin end to end: the manifest is listed and `plugin_example` passes deep health; its node validates in a flow; an order runs the node and the plugin receives `order.completed` (a `plugin:example` row in `webhook_deliveries`); the plugin's chosen branch is followed; a retried step writes one stamp per step key; `compensate` removes the stamp when the order fails after it; `pluginUsage` reports the flow; and the stock an order reserved is left for one that completed. `packages/core/tests/plugins.test.ts` covers the manifest rules (ids, reserved ids, node namespace, paths under `/plugins/<id>/`, built-in type clashes, `pluginBinding`) and the node registry (`validateGraph` accepts a plugin node only with its plugin installed). `apps/web/tests/plugins.test.ts` covers `pluginFetch`: a signed-in person is forwarded with a signed principal and no cookie or authorization, a person not signed in is refused, a public path goes through unsigned, and an uninstalled plugin is `404`. `apps/web/tests/api.test.ts` covers the admin `GET /api/v1/plugins` and `/usage`. `scripts/fleet.test.ts` covers rendering: no plugins changes no config, each plugin gets a service binding on the engine and web Workers and its own name and database, and ids, the `example` fixture and missing `d1Id` are refused.

## Catalog: shards and publishing in workerd

`apps/catalog/tests/catalog.test.ts` runs the real `CatalogApi`, `CatalogShard` and `CatalogMeta`
against local Durable Objects, R2 and KV, from the catalog's own `wrangler.jsonc` with
`remoteBindings: false` (no network or account; `testTimeout` is 60 seconds). It calls the entrypoint through
`ProductCatalogRpc`, as the web app's binding does. `tests/helpers.ts` registers the `apparel`
type, a `web` channel (`en` and `fr`, USD) and a two-level category tree once, builds
products with unique keys, SKUs and slugs, and `settle()` runs every shard's alarm by hand until
the outbox is empty, so a test reads the published R2 and KV objects deterministically. `vitest.config.ts` applies Order Loop's D1 migrations to the test `DB` in `tests/setup.ts` (read with `readD1Migrations`, bound as `TEST_MIGRATIONS`), because publishing now writes `products` rows. Product
rendering and routing are covered in core (`product-*.test.ts`), not repeated here.
`tests/feeds.test.ts` covers feeds and reindexing in the same environment (below).

| Group | Covers |
|---|---|
| writing products | A product stored at version 1 and published in every locale (the document, its enum labels per locale, an alias pointer per SKU and slug, the KV card, `getProduct`, `resolveAlias`); an unchanged product writes nothing and leaves the outbox empty, a change is version 2 and republished; invalid products are `rejected` with every issue beside valid ones in the same call (a bad enum value, an unknown type); a key repeated in one batch keeps the last row and rejects the earlier |
| aliases | A SKU another product holds is refused with `already used by <key>` and a slug the refused product claimed first is given back; the SKU is free once its holder drops it; a claim whose product no longer holds it (a release that never happened) is taken over |
| shard batches | A batch id is applied once (a repeat with different rows returns the first results and stores nothing new); a shard refuses to be called as another shard number |
| unpublishing | A draft's documents, cards and alias pointers are deleted while it still owns its SKUs, and come back when it is active again; a dropped variant's pointer goes; deleting a product removes its documents and claims, and an unknown key is `unchanged` |
| types, channels and categories | Types add versions only (a removed attribute is refused with a reason, a new type must start at 1) and an unversioned product pins to the latest; categories with an unknown parent or a cycle are refused and the published tree has localized names; a channel whose default locale isn't published is refused |

The writing-products group also checks the `u:f1:<key>` uid entry in KV, and its second write is
urgent (`putProducts(…, { urgent: true })`) so the alarm's purge send runs; no test reads the purge
queue.

### Listing indexes

`apps/catalog/tests/listings.test.ts` uses the real shards, the `CHANGES` queue (local, consumed by the Worker's `queue` handler) and `ListingIndexer`. `listing(category, n)` waits for the indexer to hold `n` members, runs its alarm by hand (`runDurableObjectAlarm`) and decodes the `idx/` object from R2 with `ListingIndex`.

| Test | Covers |
|---|---|
| ancestors | A product is listed in its category and every ancestor, with facets and sorts in the index |
| moving | A product moved between categories leaves the old listing (through `left`) and enters the new; one that stops being listed is dropped |
| ordering | The latest change by `at` wins when changes arrive out of order |
| `withAncestors` | Every ancestor once; a cycle stops |

### Keyword search

`apps/catalog/tests/search.test.ts` calls the catalog's real `SearchApi` through `exports` after `putProducts` and the publish and `CHANGES` queue have run, polling `until` the expected `total` arrives (the queue is asynchronous).

| Test | Covers |
|---|---|
| finding | Title words, a prefix on the last term, SKU parts and brand; the title outranks the brand; every term is required; each locale has its own index |
| removal | A product leaves search when it is unpublished or deleted |
| paging | Pages across the 16 shards come out in score order with the same `total`; syntax characters in a query are text |

### Feeds

`apps/catalog/tests/orders.test.ts` covers Order Loop's `products` rows: publishing a product writes each variant's SKU with its name (`Field jacket (S)`) and price (a variant's own price over the product's), and leaves an existing row's `stock` alone; and `applyOrders` never lets an older change overwrite a newer one (`catalog_at`), across batches and within one.

`apps/catalog/tests/feeds.test.ts` runs the real `FeedImport` Workflow, the `FEED_PARTS` queue consumer and `CatalogFeeds` in workerd, polling `feedStatus` until a feed is `done` or `failed`. `vitest.config.ts` binds `FEED_CHUNK` to `300`, so a 1,000-product feed spans several `split` steps. It also binds `LISTING_DELAY_MS` to an hour: listing indexes build only when a test runs the indexer's alarm, because one firing on its own as a file ends is cut off mid-RPC and vitest fails the run on the unhandled error.

| Test | Covers |
|---|---|
| CSV feed | 1,000 products of two variant rows each across several steps: counts of `created` and `rejected`, `parts` equal to `partsDone`, rejected rows reported by their row number and product key with the attribute named; a product stored with both variants; the file again gives `unchanged` for every valid product and the same rejections; `listFeeds` newest first |
| NDJSON feed | A SKU claimed twice across shards is a shard-level refusal reported with its line (`already used`), and a line that isn't JSON is `{ row, message: 'invalid JSON' }`, in a file delivered in 7-byte reads |
| unusable header | A CSV with no `key` and `sku` columns ends `failed` with the reason in `failure` |
| `storeStream` | A stream just over 10 MiB is stored as a multipart upload, with the right size |
| reindex | A published document deleted from R2 is back after `reindex` and the shards' alarms, and `queued` counts the products |

miniflare logs "Worker's code had hung" once per Workflow instance in these tests (the engine's
Workflow tests log it too, 34 times in `orders.test.ts`). It is harmless: the tests pass.

## Design

`packages/design/tests/tokens.test.ts` holds the Ledger tokens in `packages/design/src/tokens.ts` to
`apps/web/app/app.css`, value for value in both schemes, plus the font stacks, and fails when the
generated `apps/docs/src/styles/theme.css` is stale. Fix it by mirroring the `app.css` change in
`tokens.ts` and running `pnpm sync:theme`.

## Web

`apps/web/tests/`:

| File | Covers |
|---|---|
| `api.test.ts` | REST order actions against a mocked engine (also the order-list cursor round trip, and `400` for a cursor the API did not issue): an unknown order is `404`, deciding a node that isn't waiting, deciding an order the caller started (`403` with the refusal; the caller's id is passed as the decider) and cancelling a finished order are `409`, and an event nothing waits for is `200` with `delivered: false`. Signed events: a signature that names no integration, an unknown one or the wrong secret is `401`; a key is held to its events and, if channel-bound, to its channel's orders (`403`, and `404` for an order it can't see). Only a verified signature spends its integration's budget, and one over it is `429` with `Retry-After`. Integrations over REST: create shows the secret once and records who did, rotate and revoke, `404` for an unknown key, operator only |
| `api.test.ts` (data subjects) | `POST /api/v1/data-subjects/export` and `/erase` are admin only (`403` otherwise) and refuse an invalid email with `400`; the audit log names the person by a hash, not the address; erase answers `409` while their orders run |
| `openapi.test.ts` | The OpenAPI document serialises, request bodies come from the zod schemas (every content type of each), the Stripe and Shopify routes are unauthenticated (Stripe's with `200`, `400`, `409` and `503`) and the EDI route is not, every outbound event is listed, signed inbound events are unauthenticated; subscription URLs require https except on localhost and default to every event |
| `credentials.test.ts` | PBKDF2 hashes verify only the right password and use a fresh salt; malformed or out-of-range hashes fail; `ol_live_` tokens are stored as SHA-256 with a 12-character prefix; generated passwords, email normalisation; the password policy |
| `rate-limit.test.ts` | Per-caller budgets: a caller goes through while its budget lasts, then gets `429` with `Retry-After: 60`; another caller has its own budget; without the binding nothing is limited |
| `throttle.test.ts` | Sign-in keys (email and address, address, email; a blank email as `(no email)`); a key blocks at its limit until its window ends, old windows don't count, each kind has its own limit (including `setup-ip`) and the longest wait wins; waits round up to whole minutes |
| `setup.test.ts` | The setup code (`/setup`): creates the first admin once, then stops working; counts and audits a wrong code (`team.setup_refused`); keeps the code working when the account couldn't be created; recovers with a new code once the team has people (`team.recovery_admin`); opens nothing without a code |
| `origin.test.ts` | `crossOrigin`: reads pass from anywhere; writes from another origin, a sibling subdomain, `null` or plain http are refused; the WebSocket handshake is checked although it is a `GET`; the `Sec-Fetch-Site` fallback; clients with neither header pass |
| `ago.test.ts` | `Ago` server-renders a machine-readable time with the UTC time as its tooltip, and a dash without a time |
| `inbound.test.ts` | `POST /api/v1/webhooks/orders`: starts the routed flow once per channel and external id, with a payload fingerprint; `ORDER_ROUTES` is used and an unpublished flow refused; a bad signature, a bad body and an unknown currency are refused; each integration is held to its scope (`startOrders`, channel, `flows`) with `403`; a signed order is audited once against its integration (`via: 'webhook'`) and the replay is not |
| `channels.test.ts` | The channel routes: a Shopify order starts once for the customer matching its email; a bad signature is refused, other topics ignored and unmappable orders reported; an 850 interchange starts one order per PO for the partner's customer; unknown partners, bad X12 and callers below `operator` are refused |
| `stripe-webhook.test.ts` | `POST /api/v1/webhooks/stripe`: a verified event reaches `EngineRpc.paymentEvent`; any of several `v1` signatures passes; a bad or missing signature is `400` without calling the engine; a `retry` outcome is `409`; an unset secret `503`; a signed body that isn't an event `400` and an engine failure `500` |
| `totp.test.ts` | Base32 round-trips; TOTP matches the RFC 6238 vectors, accepts one step of drift either way, refuses a step already used, takes spaces and dashes in a typed code and builds the `otpauth` URI; recovery codes are ten distinct, readable codes that hash ignoring case, spaces and the dash |
| `sso.test.ts` | Single sign-on (`lib/sso.ts`, `lib/sso.server.ts`): domains parse from an admin's text (case and `@` ignored, junk and repeats dropped) and settings read back with unreadable values at their default; `decideSso` signs in the linked person unless disabled, links a teammate by email once and never over another identity, and adds someone new only when a role is set and the domain is listed; the flow against a stub provider sends PKCE, `state` and `nonce` and signs in who the token vouches for, refuses another state, a token for another client or issuer and a stale nonce, ignores an unverified email, and refuses a callback with no flow cookie or a provider error |
| `scim.test.ts` | SCIM (`lib/scim.ts`, `lib/scim.server.ts`), the protocol over an in-memory `ScimStore`: the `eq` filters and refusal of other filters; `userName` as the email; Okta's and Entra's User and Group PATCH shapes (capitalised ops, string booleans, path-less values, filtered member removes); the highest mapped role or viewer; creating once and `409` on a duplicate; deactivating ends access, reactivating restores it, and `DELETE` leaves groups; the last active admin is never deactivated or demoted; roles follow mapped groups and unmapped groups change nothing; discovery, errors in SCIM shape and `404`; 1-based paging |
| `passkeys.test.ts` | Passkey sign-in works once per challenge and checks this host (origin and RP ID, user verification required, counter updated, audited as `auth.sign_in` with method `passkey`); an unknown passkey, a disabled person and an answer that doesn't verify are each refused and counted as a failure; adding a passkey needs the password and uses its own challenge; removing works only on your own passkey, after the password |
| `two-factor.test.ts` | The `two_factor_required` setting is `operator` until an admin chooses otherwise, covers the chosen role and above, accepts only known values and is described in the audit log |
| `audit.test.ts` (core) | The audit hash chain: events numbered from 1 and linked, an edited, removed or reordered event found, a pruned chain checked from its first remaining event or a known head, an unsealed event refused; retention defaults to 400 days and never goes under 90 |
| `audit-log.test.ts` (engine) | One chain even when writers race; the database refuses to change an event or delete one younger than 90 days; `archiveAudit` writes events past the retention to R2 as NDJSON, deletes them and leaves an unbroken chain |
| `audit.test.ts` | Audit events described in one line (role changes as from → to, token roles, failure reasons); every action belongs to a filter group, including `scim`, `integration`, `personal_data` and the business groups (`order`, `approval`, `flow`, `webhook`, `stock`, `catalog`) |
| `catalog-api.test.ts` | `/api/v1/catalog` against a mocked `ProductCatalogRpc` (`~/lib/env.server`'s `catalog()`): an operator's product write is forwarded with `by` and `urgent` and audited with the created, updated, unchanged and rejected counts; a viewer can't write, a malformed body and 501 products are `400` and never reach the catalog; reads and alias lookups for a viewer, `404` when unknown; deletes; a type the catalog refuses is `409` with its reasons; channels and categories; a feed file streamed to `startFeed` with `202`; `reindex` for an admin only; anything else is `404` |
| `tokens.test.ts` | API token lifetimes: 30 days, 90 days and 1 year, with no `never` or longer lifetime; token state active, expiring within 14 days, expired at its expiry time, revoked first |
| `sessions.test.ts` | `describeAgent` names browser and system (Chrome, Edge, Safari on iOS, Firefox on Linux, curl, unknown); `sessionRef` |
| `dev-key.test.ts` | The dev principal key and data key in `vite.config.ts` (the engine uses them) equal core's `DEV_PRINCIPAL_KEY` and `DEV_DATA_KEY` (the web app uses them) |
| `mcp.test.ts` | `/mcp` and `/a2a` on the web Worker, with auth and the engine mocked: only MCP, A2A and OAuth protocol paths go to the provider (not `/oauth/authorize`); one authorization server advertises both resources; `/a2a` challenges with its own resource metadata and forwards a token caller; an OAuth token is bound to the endpoint it was granted for; a request without a token gets `401` pointing at the resource metadata; an API token caller is forwarded without its credential and with the principal header signed for that path; unknown tokens `401`, throttling `429` with `Retry-After`, expiry `401`; a caller still on a temporary password or owing two-factor setup `403`; a malformed `Origin` `403`. `vitest.config.ts` inlines `@cloudflare/workers-oauth-provider` so the `cloudflare:workers` mock applies |
| `ucp.test.ts` | `/ucp/*` and `/.well-known/ucp` on the web Worker, with the engine mocked: a request without a platform key is `401`; REST needs `UCP-Agent` naming the key's own profile (`400`, `403`); `404` while agentic checkout is off; a request is forwarded with a signed platform header (`signPlatform`) and without the key; the profile is public and `404` while off |
| `approvals.test.ts` | Approval context for a credit check: the order in its own currency with its USD equivalent, and limits, balances and the shortfall in USD |
| `demo.test.ts` | Demo mode is off unless `DEMO_MODE` is `"true"`; then it refuses changes on Team and Account (pages and `.data` requests) while they stay readable, closes `/oauth/authorize`, integrations and webhook subscriptions entirely, and leaves orders, flows, approvals and sign-out alone |
| `new-order.test.ts` | The New order lines grammar (each spelling, no number as one; no SKU, zero or negative, two numbers and SKUs outside the catalog are issues, not guesses); a catalog click adds a row or one more; `summarizeFlow` names where a flow asks a person, what it waits for and what it undoes, and whether it reads a document or routes fulfillment |
| `scenarios.test.ts` | Every demo scenario targets a valid seeded flow of its model; money, relative time, UTC date and duration formatting; status-to-token mapping |

`scripts/fleet.test.ts` (run by `pnpm test:fleet`) also covers the catalog's rendering: `renderCatalog` gives the Worker its own name, R2 bucket and `CARDS` namespace id from `catalogKvId`, suffixes its Workflow name and its feed-parts queue, consumer and dead-letter queue names, renders the changes queue as a producer and a second consumer (`orderloop-catalog-changes-<id>`), sets `DATA_JURISDICTION` and the bucket's jurisdiction from the registry, binds `DB` to the deployment's own D1 (`d1Id`, for the `products` rows it writes), and refuses a deployment without `catalogKvId`; `orderloop` renders the committed `apps/catalog/wrangler.jsonc` unchanged; a `catalogKvId` that isn't 32 hex characters is refused; `matrix` refuses a deployment without `d1Id` or `catalogKvId`.

`scripts/fleet.test.ts` also covers catalog-edge: `renderCatalogEdge` gives the Worker its own name (`orderloop-catalog-edge-<id>`), points its `CATALOG` service binding at the deployment's catalog (`orderloop-catalog-<id>`, entrypoint `SearchApi`), a custom-domain route for `catalogDomain` (default `catalog.<domain>`), the deployment's bucket (with its jurisdiction), `CARDS` namespace id, purge queue and dead-letter queue consumer (`max_concurrency` 1) and Analytics Engine dataset (`orderloop_catalog_edge_<id>`); the catalog's `PURGE` producer names the same queue; a `catalogDomain` that isn't a host name is refused; `orderloop` renders the committed `apps/catalog-edge/wrangler.jsonc` unchanged.

`scripts/fleet.test.ts` also covers the registry's `sso`: it sets the web Worker's `OIDC_ISSUER` and `OIDC_CLIENT_ID` (empty without it), and refuses a non-https issuer or a missing client id.

## Catalog edge: delivery in workerd

`apps/catalog-edge/tests/edge.test.ts` runs the gateway and `Delivery` against local R2 and KV,
from the Worker's own `wrangler.jsonc` with `remoteBindings: false`. `beforeAll` writes what the
publisher would (two products, one in two locales, SKU and slug alias pointers, a category tree, uid
entries and cards) with `paths` from `@orderloop/core/product/paths`, and requests go to the default
entrypoint through `exports`.

| Group | Covers |
|---|---|
| documents | A product document with its content type, `Cache-Control` (`FRESH`), a quoted `etag` and CORS; a `304` with no body when `If-None-Match` matches; SKU and slug lookups (a slug in its own locale); a missing product or SKU is `404` with `MISSING`; the category tree; `HEAD` has no body |
| batches | Cards in the order asked, `null` for unknown keys, a repeated key once; no `keys`, 101 keys or a malformed key is `400` (`at most 100 keys`) |
| the gateway | `POST` is `405`; `OPTIONS` is `204` allowing `if-none-match`; a wrong version prefix or unknown kind is `404`; a bad channel, locale or slug is `400`; `/health` is `{ ok: true }` |
| purging | A queue batch with a repeated tag is acknowledged (`ackAll`, no retry) |

`apps/catalog-edge/tests/listing.test.ts` writes a listing index (built with core's `buildListingIndex` and `listingSpec`) and its cards, and requests `categories/<code>/products` through the gateway:

| Group | Covers |
|---|---|
| pages | Newest first with `total` and `next`, facets over the whole result with labels, range `min`, `max` and buckets |
| filters and sorts | Term and range filters, price sorts, facet counts that stay disjunctive |
| refusals | A sort the index lacks, bad filters, ranges, cursors and limits (`400`) and an unknown category (`404`) |
| the internal path | `/_idx/…` is not reachable through the gateway |
| cache keys | Equivalent pages (filter order, value order, default `sort`, `cursor` and `limit` spelled out) have one canonical URL |

`apps/catalog-edge/tests/search.test.ts` requests `search` through the gateway. The catalog is a stub Worker named `orderloop-catalog`, defined in `vitest.config.ts` (miniflare `workers`) and answering only `tee` (uids 7, 70 and 71), so the service binding resolves without Durable Objects:

| Group | Covers |
|---|---|
| matching | Cards in match order, with `total` and `next` paging |
| exact SKU | A one-word query that is a product's SKU puts that product first |
| refusals | A query without a word and a `cursor` at or past `SEARCH_DEPTH` are `400` |
| cache keys | Equivalent queries (case, spacing, default `cursor` and `limit` spelled out) have one canonical URL |

Workers Caching isn't emulated locally, so these tests check what reaches the cache (canonical URLs,
headers, `304`s) and not hits, misses, stale serving or tag purges: `Delivery.purge` is a no-op
without it, so the test only checks the acknowledgement. Nothing in the repository tests those; the
deploy's smoke test requests only `/health`, which the gateway answers without the cache.

## What isn't covered

The flow editor canvas and the live order page are not under test; verify UI changes by running
`pnpm web:dev` and driving a scenario. See [Getting started](local-development.md).
