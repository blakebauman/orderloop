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
| `packages/plugin-sdk` | Node | `packages/plugin-sdk/vitest.config.ts` |
| `plugins/example` | workerd, through `@cloudflare/vitest-plugin`, with the plugin's own D1 | `plugins/example/vitest.config.ts` |
| `plugins/fixture-carrier` | workerd, through `@cloudflare/vitest-plugin`, with the plugin's own D1 | `plugins/fixture-carrier/vitest.config.ts` |
| `apps/engine` | workerd, through `@cloudflare/vitest-plugin`; five projects, `engine`, `plugins`, `sandboxed`, `installs` and `stripe` | `apps/engine/vitest.config.ts` |
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
| `credentials.test.ts` | `scrubCredentials` (what a sandboxed plugin's text passes before it reaches the timeline or logs): the values it is given replaced longest first; credentials caught by shape (prefixed keys, GitHub and AWS tokens, bearer tokens, JWTs, URL credentials, `key=value` pairs, private keys); long random runs masked while ordinary text and ids are left alone |
| `provenance.test.ts` | Each AI prompt has a version and `promptId` names it (`router@1`); the assistant budget is a million tokens a day unless set, `0` is no limit, and a bad value is the default |
| `assess.test.ts` | Assess questions held to Clef's limits (1–64 questions, 2–255 options, 2–10 score levels); the node's outputs (a choice's options, yes/no for `noul`, `unsure` with a confidence floor, none to branch on for a score); `assessBranch`; `clampAnswers` dropping unknown options, renormalising and recomputing the choice and score; `branchOn` validation through `validateConfig` |
| `address.test.ts` | `checkAddress`: clean addresses pass unchanged; whitespace, country aliases, region names and US, CA and GB postcodes are corrected; unknown fields are dropped; missing fields, unknown regions and countries, bad postcodes and free-text ship-tos are rejected with every issue listed |
| `encryption.test.ts` | `encryptSecret` / `decryptSecret`: a value reads back under the current key with a fresh IV each time; one moved to another row (different context) or altered is refused; values under the previous key read during a rotation and not after; a value without the `e1.` prefix passes through; no key to encrypt with throws |
| `erasure.test.ts` | Data subject matching and erasure: the email is trimmed and lower-cased; terms are longest first and under 3 characters skipped; `eraseOrderState` removes contact, document text and personal `meta`, replaces the subject's names and masks emails and phones through the state, and keeps lines, amounts and statuses; `personalDataRetentionDays` keeps data when unset or zero and never goes under 30 |
| `api.test.ts` | `startFingerprint`: property order is ignored, while version, vars, values and line order change it. `mergeTimeline`: a short broadcast is the whole timeline, a full one keeps the older entries a page held, a re-keyed entry replaces the one held, and the result is capped at `TIMELINE_CAP` |
| `a2a.test.ts` | `ORDER_TASK_STATES`: an order status is a finished task state exactly when it is a finished order status; a waiting order's text names each approval (`nodeId`) and event and how to reply; every assistant tool is a skill at its own role and `place_order` needs `operator`; the Agent Card points at the given origin and its OAuth metadata |
| `checkout.test.ts` | The checkout session (`checkout.ts`): `applyLines` numbers new lines `li_1`… and keeps the ids it is given back; `patchCheckout` replaces only what the patch names; `missingInfo` and `openStatus` (a digital order needs lines and an email; goods that ship also need an address and an option unless the flow picked one; an error only a person can clear escalates, warnings are ignored); `isOpenCheckout` and `isExpired`; `quoteNodes` takes the pricing and policy nodes in the order the flow reaches them and ignores loop back-edges; `checkoutFlowProblem` refuses a flow that never holds a card payment |
| `cart.test.ts` | Carts (`cart.ts`): staff read from viewer and edit from operator, a guest only an external cart; `applyCartOp` adds a SKU as a new line or to the line that has it, keeps quantities whole and within `MAX_LINE_QUANTITY`, caps lines, removes a line at 0, removes in bulk and clears, refuses line and promo changes on a locked cart, keeps lock, unlock and rename to staff and changes nothing once final, and bumps the version (repricing only when lines or codes change); promo codes normalised, deduplicated and capped; `cartReadyProblem` needs lines and a quote for this version without errors; `finishCart`; `isCartExpired` only for an open external cart; chat bodies trimmed and bounded, changed only by their author |
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
| `product-routing.test.ts` | The catalog's frozen layout: FNV-1a 64 against the published vectors and a BigInt reference for UTF-8; golden shard, alias-shard and search-shard numbers for fixed keys (never update them: a change strands stored products); 64 and 16 shards; even spread; golden `listingSegment` numbers, 8 `LISTING_SEGMENTS` and an even spread over them (a change needs a full listing rebuild); `productUid` packing into 32 bits and refusing to overflow; `canonicalJson` and `contentHash` ignoring key order and seeing any change |
| `product-model.test.ts` | Product types refused when they can't be indexed or told apart (enum without values, localized non-text, sorting non-numbers, duplicate codes, json filters, bad variant axes); `typeChangeIssues` allowing only additions; `validateProduct` pinning the type version, defaulting the primary category and naming each bad attribute, duplicate SKU, repeated or missing variant options, bad slug and unknown type; GTIN check digits (`isGtin`), every length read as one GTIN-14 (`gtin14`, `claimedAlias`), a bad check digit or one GTIN on two variants refused; an MPN trimmed and bounded; `productAliases` claiming GTINs as GTIN-14; GTIN and MPN published per variant and searchable; `renderForChannel` resolving locales with fallback, enum labels, channel and variant prices, cards, search text and the index entry, and publishing nothing for drafts or unlisted products (fixture: `tests/fixtures/product.ts`) |
| `product-listing.test.ts` | The segmented listing index against a brute-force oracle on 3,000 pseudo-random products (coarse creation times and prices, so ties are common) split over the 8 segments by `listingSegment` and built with `buildListingIndex`: uids and `createdAt` round-trip in member order; `queryListing` with dense (bitset) and sparse (list) term filters, ranges, both price sorts and disjunctive facet counts summed over segments; 120 random queries (filters, ranges, sorts, buckets, page sizes 1 to 60) whose totals, facet counts, ranges and buckets match the oracle and whose pages, followed to the end, are exactly the oracle's order with no member skipped or repeated; range buckets with min and max; an unknown sort, a bad cursor, foreign bytes and format 1 refused; an empty category and segments with no members; a sort column only some segments have values for (their members last); a sort offered only when every present segment has it (a segment built without it, not rebuilt, withdraws it); labels and default buckets from the most recently built segment; `encodeListingCursor` / `decodeListingCursor` round trips and strict refusals (wrong count, negative, leading zeros, upper case, unsafe integers); `listingSpec` (terms, numbers, sorts, buckets and per-locale labels from the types) and a built index keeping `buckets` and `labels` and counting the stored buckets by default |
| `product-search.test.ts` | `normalizeQuery` folding case, width (NFKC) and spacing and capping at `QUERY_MAX`; `ftsQuery` quoting every term and prefix-matching only the last; FTS5 syntax (operators, column filters, quotes) coming out as plain quoted terms |
| `product-feed.test.ts` | Streaming CSV records (quotes, `""`, newlines inside fields, CRLF, BOM, UTF-8 split across chunks, an unterminated quote, bytes that aren't UTF-8 failing) and NDJSON lines (bad lines reported by number); each record's `end` offset as a cursor: a ranged read from the `end` of any record yields exactly the records after it, at the same offsets, for CSV and NDJSON; CSV rows grouped into products with cells read by attribute kind and channel prices in minor units; `gtin` and `mpn` read per variant row; a bad row reported against its product while later rows still parse; resuming mid-file from a product boundary with the saved header gives the rest of the products; `key` and `sku` columns required |

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
- Five vitest projects share that setup. `engine` runs `tests/*.test.ts` with payments in the
  default `mock` mode, where `meta.simulate` drives declines, and no plugins installed. `plugins` runs `tests/plugins/**` with the example plugin (`plugins/example`) bound as the auxiliary Worker `orderloop-plugin-example` and service binding `PLUGIN_EXAMPLE` (bundled from `plugins/example/src/index.ts` by `bundlePlugin` from `@orderloop/plugin-sdk/testing`, with `PLUGIN_KEY` `test-plugin-key`), its own D1 `EXAMPLE_DB` and `TEST_EXAMPLE_MIGRATIONS`, and the fixture carrier (`plugins/fixture-carrier`, a provider of every surface) as `orderloop-plugin-fixture-carrier` and `PLUGIN_FIXTURE_CARRIER`, with `CARRIER_DB`, `TEST_CARRIER_MIGRATIONS` and buyer details granted in `PLUGIN_GRANTS`; run it with `pnpm --filter @orderloop/engine exec vitest run --project plugins`. `sandboxed` runs `tests/sandboxed/**` with the same two plugins as Dynamic Workers instead (see [Sandboxed plugins](#sandboxed-plugins)); run it with `--project sandboxed`. `installs` runs `tests/installs/**`: plugins an admin installs at runtime (see [Runtime installs](#runtime-installs)); run it with `--project installs`. `stripe` runs `tests/stripe/**` with
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
| `tests/agent.test.ts` | `OrderAgent.report`: replayed snapshots ignored, timeline keys deduped, a new generation accepted; terminal statuses and rolled-back nodes kept once set; the synced state without the flow and with the newest 50 entries while `snapshot()` and `getFlow()` return the flow and the whole capped timeline; an agent whose state still holds the flow moving it and its timeline to SQL |
| `tests/assistant.test.ts` | The assistant's heuristic model reads plain requests into one tool call, never offers a tool the role lacks, links what it finds and treats a malformed page context as the workspace; action previews resolve against live data (decision, cancel effects, events nothing waits for) and refuse roles that can't make them; the `AssistantAgent` socket opens only for its own person, returns `attention()` and `preview()`, and stops when the sign-in ends; a confirmed action records `<email> via assistant`; a decision through the assistant and a cancel through MCP each write one `audit_events` row with `via` and `tool` |
| `tests/principal.test.ts` | `/mcp` and `/a2a` refuse an unsigned, forged, expired or other-path principal header (`tests/principal.ts` `signed(p, path)` signs with the test binding `PRINCIPAL_KEY`); `livePrincipal` drops an API token once revoked or expired and follows its role, and ends open local dev once a user exists |
| `tests/mcp.test.ts` | `/mcp` refuses a request the web Worker did not forward; `tools/list` offers a viewer 7 tools and an operator 13, with titles, annotations and input schemas; reads return `structuredContent`; `assess_order` answers heuristically and skips another order's image key with a note; a tool the role lacks is unknown; a refusal from live data is a tool error; an action's first call returns a preview and a `cfm_` code and changes nothing; a code is refused for another person, another input or an unknown value, works once, and the decision is then recorded as `<email> via MCP` |
| `tests/injection.test.ts` | Prompt injection against a stub model that records what it is sent: extract, risk, classify, router and summarize put the attack text only in data blocks under `DATA_RULES` that it can't close; the router's author instructions follow the fixed rules and are cut to length; a manipulated answer is held to its bounds (catalog SKUs and quantities, score 0–100, confidence 0–1, text lengths), and an off-list route falls back to the heuristic |
| `tests/confirmations.test.ts` | Confirmation codes: a code is refused at `CONFIRMATION_TTL_MS`, accepted with the input's keys in another order, refused for another tool, and `pruneConfirmations` drops codes a day after they expire (single use and the other-person case are in `mcp.test.ts`) |
| `tests/cart.test.ts` | Carts on the engine: `createCart` refuses a flow with no published version, an unknown customer and an empty title, and indexes the cart in `carts`; `cartSnapshot` is null for an unknown id; a cart is priced by its flow's nodes for its customer (Northwind's contract price, not list); a SKU the store doesn't sell is an `item_unavailable` issue and blocks submitting; the socket refuses a request without a live principal (none, or a forged session) with `401` and an unknown cart with `404`; a viewer reads but can't edit, an operator edits, and `members` lists everyone with it open; chat is posted as the caller, changed and deleted only by its author, empty bodies refused, history paged; submitting needs an operator, starts one order of the cart's flow (customer, `externalId`, `startedBy`, channel `manual`) and ends the cart, after which nothing changes it; cancelling once, by an operator |
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
| `tests/orders.test.ts` | End-to-end orders on every template: B2B extraction, auto-approval, shipping and payment; credit-limit approval and decline, and an approval nobody decides in time ending on its own reason; the dunning loop, with a timed `node_runs` row per run of each step and wait; out-of-stock failure and rollback, and `meta.simulate` dropped on a deployment that doesn't allow simulated failures; cancel releasing everything; subscription retries (the card verified, not held); reorder forecast and restock; storefront ship, capture, return and partial refund; storefront shipping charged at the cheapest option and taxed, a chosen option charged abroad and booked with its carrier, and an option that isn't offered declining the order; restocking only a partial return's lines; per-order reservations and the stock ledger under retries; each line's guard holding in the one batch a reserve step writes (a later line short of what earlier lines left, while another SKU's line holds) and a release moving each held line once; two orders racing for the last units (one is short); a cancel racing a rollback and a shipment releasing a hold once; a retried capture returning the same payment; a capture and a void racing (exactly one wins); a continue-as-new flow charging again in the next generation although its step names repeat; policy cancel; return window closing; idempotent capped refunds; an inbound order's retry matching after its route changes and refused with different contents; the engine RPC reporting an unknown order, `startedBy` recorded and, once the workspace separates duties, neither the RPC nor the agent letting the starter decide while another person can, a step not waiting and an order already finished; a marketplace order waiting on one seller, paying both out net of commission, capturing only what a partial acceptance kept (shipping kept and tax re-applied at the tax node's rate), failing and voiding when no seller answers, and cancelling seller orders on a later failure; a guest checkout emailing the contact address; guests and consumers taking a credit check's no-account branch; only unpaid business invoices billed on account; `Idempotency-Key` races, half-started replays and fingerprint mismatches; outbound webhook signing, retry and give-up; `order.cancelled` and `order.failed`; address validation branching on a published test flow; the pricing chain against the seeded sources (price book, contract, volume and list per customer, per-node switches, given prices, reordering and turning off sources); pricing in EUR at the stored rate, given prices left alone and an unknown currency rejected; credit checked in USD for a GBP order; the agent socket refusing a viewer's decide and cancel and a socket without a principal, and recording an approver's own email as `by`; an open socket following a role change, a disabled user, a signed-out session and a forged session id; an idle session refused and socket calls recording activity; the offline copilot; Assess: branching on the chosen option and storing every answer, `unsure` below the confidence floor, and `resolveImages` accepting only the order's own R2 keys, https and data URLs; omnichannel and point of sale: a pickup holding the store's stock with a six-character code then handing it over on `pickup.collected`, an uncollected pickup releasing the store's stock, cancelling the pickup and voiding payment, ship-from-store with an e-book code and one capture for the full total, shipping from the store nearest the ship-to, a split shipment across the warehouse and the nearest store with one shipment per source, codes revoked when the physical part can't be fulfilled, and a till sale from the store's stock with an emailed receipt; orders mapped from Shopify (the payload's price kept) and from an X12 850 (a B2B order for the partner's customer) running their flows |

Tests drive orders through `startOrder`, then poll the agent's `snapshot()` until a predicate holds
(`until`, `waitingOn`, `settled`), and assert on D1 rows (`payments`, `reservations`, `location_stock`, `entitlements`, `shipments`,
`approvals`, `webhook_deliveries`) as well as state.

### Plugins

`tests/plugins/example.test.ts` (the `plugins` project, helpers in `tests/plugin-helpers.ts`) runs the example plugin end to end. `an installed plugin`: `pluginCatalog` lists a `PluginStatus` (`healthy`, manifest with `apiVersion` and `personalData`) and `plugin_example` passes deep health; its node validates in a flow; an order runs the node and the plugin receives `order.completed` (a `plugin:example` row in `webhook_deliveries`); the plugin's chosen branch is followed; a retried step writes one stamp per step key; `compensate` removes the stamp when the order fails after it; `pluginUsage` reports the flow; and the stock an order reserved is left for one that completed. `what the engine accepts from a plugin`, with the test-only `example.probe` node: an order reaches the plugin without the contact, names and addresses (`personalData` `redact`); `vars` land under `vars.plugins.example`; `fail`, an oversized `output` and a branch the node lacks fail the node with no retries; `fail` with `retry` is retried; and a binding whose `manifest()` rejects reports `healthy: false` with its error while keeping the last good manifest. `a plugin that is down, redeployed or asks too much`: planning (`load-plugins`) retries while a bound plugin the flow uses hasn't answered; a node whose bound plugin isn't answering is retried and fails for good only when unbound; a node's branch is checked against the manifest the order was planned with; a plugin asking for `personalData: "send"` without a grant is refused (and a withdrawn grant beats the last good manifest); an event's `data` is redacted for a plugin without buyer details; and a failed order counts in `pluginUsage` until it is rolled back.

`packages/core/tests/plugins.test.ts` covers the manifest rules (ids, reserved ids, `apiVersion`, node namespace, paths under `/plugins/<id>/`, built-in type clashes, `pluginBinding`), the node registry (`validateGraph` accepts a plugin node only with its plugin installed; plain nav and public paths, the manifest size cap, at most 50 nodes and fields), `checkExecResult` (default first output, `fail` retried only when it says so, a branch the node lacks, a long summary or fail message cut rather than refused, an oversized output), `pluginKey` (a fixed vector, different per id and per key) and what a plugin is sent (`pluginOrder` builds a `RedactedOrder` from an allowlist, with no `meta`, document text or key, or payment ids; `pluginView` redacts; both unless `personalData` is `send`). `packages/plugin-sdk/tests/sdk.test.ts` covers `definePlugin` (manifest and handler mismatches refused at load, a node run with its write `key` and `fail`, events dispatched by name, pages for a verified person with the page role only) and `pluginContract` (passes a plugin that keeps the contract; catches a node that writes again on a retry, one keyed by the order alone, one that writes nothing unless listed in `noEffects`, a page that lets anyone in, a delivery recorded twice, and a manifest that doesn't parse; `compensate` throws for a node the plugin lacks, and a subscribed event needs a handler). `plugins/example/tests/contract.test.ts` runs `pluginContract` against the example in workerd with its own D1 (`pnpm --filter @orderloop/plugin-example test`); every plugin carries one. `tests/plugins/providers.test.ts` runs the fixture carrier as provider end to end: an order rated, address-checked, taxed and labelled by it (the shipment row records `provider` and `external_id`); the label voided when the order fails after it and when it is cancelled (`compensateOrder`); rates falling back to the static services when it is down; and `validateGraph` refusing a provider that doesn't provide the surface or isn't installed, with `pluginUsage` counting the flows that name it. `packages/core/tests/plugins.test.ts` (`providers`) covers `provides` (buyer details needed except for rates, no duplicates), `NodeRegistry.providers` and provider validation, `flowPlugins` and `checkProvideResult`; `packages/plugin-sdk/tests/sdk.test.ts` (`providers`) covers handlers required per op, an op the plugin doesn't provide, and `pluginContract` catching labels not keyed by the step. `plugins/fixture-carrier/tests/contract.test.ts` runs `pluginContract` against the carrier. `packages/core/tests/plugins.test.ts` (`sandboxed plugins`) covers `egress` hosts (`egressAllows`: exact names, `*.` wildcards that also match the bare domain, nothing that merely ends in the name), `limits` over the caps refused, a secret that is either `inject`ed (into a host in `egress`, with an allowed header and a `{}` format) or `expose`d and never both, and the ids reserved for the engine's plugin variables (`bundles`, `secrets`, `grants`, `key`, `storage`, `dev-bundles`, `publishers`); `packages/plugin-sdk/tests/sdk.test.ts` (`secret() and pluginDb()`) covers `secret` and `hasSecret` reading a Worker secret, a Secrets Store binding or the sandbox's `SECRETS` capability (which hides an `inject`ed one), and `pluginDb` giving D1's own binding or D1-shaped statements over the sandbox's `STORAGE`. `apps/web/tests/plugins.test.ts` also sends a sandboxed plugin's page through `EngineRpc.pluginFetch` under the same rules (signed principal with the plugin's key, only allowed headers, no `set-cookie`, the CSP), and `apps/web/tests/api.test.ts` expects `GET /api/v1/plugins` to return `id` and `runtime` (not `binding`) and `pluginUsage` its `labels`. `apps/web/tests/plugins.test.ts` covers `pluginFetch`: a signed-in person is forwarded with a signed principal and only the allowed headers (no cookie, authorization or proxy headers), a person not signed in gets `401` and one below the page role `403`, a public path goes through unsigned within its `WEBHOOK_LIMIT` budget (`429` over it), signed-in page requests spend `API_LIMIT` per person, only allowlisted response headers pass (no `set-cookie`, HSTS or service-worker scope) under a CSP with no script, a redirect leaving the plugin's own pages is `502`, the principal is signed with the plugin's own key and has no session id, a body over `MAX_PLUGIN_BODY` is `413` when declared and errors when streamed, and only `/plugins/<id>/` is forwarded (an uninstalled plugin is `404`). `apps/web/tests/api.test.ts` covers the admin `GET /api/v1/plugins` (`binding`, `healthy`, `error`, null `id` for a refused plugin) and `/usage`. `scripts/fleet.test.ts` covers rendering: no plugins changes no config, each plugin gets a service binding on the engine and web Workers and its own name and database, ids, the `example` fixture and missing `d1Id` are refused, a plugin may declare only vars and its `DB` database, the plugin key derived by `fleet.ts` equals core's, and buyer details reach the engine's `PLUGIN_GRANTS` only through the registry's `personalData`.

### Sandboxed plugins

The `sandboxed` project (`tests/sandboxed/sandboxed.test.ts`) runs the example and the fixture carrier
the way a deployment runs a `sandboxed` plugin, through Worker Loader, with no auxiliary Worker or
service binding. `vitest.config.ts` builds each bundle with `buildSandboxBundle` (from
`@orderloop/plugin-sdk/testing`: its code as one module, its migrations, and the sha) and passes the
set to the tests as `TEST_BUNDLES`; the project's bindings are:

From the reviews, `tests/sandboxed/` also proves: an upstream echoing the injected credential leaves `[redacted]` in the order (`scrubbedValue`); a request body over 10 MiB gets `413`; egress and secrets hold with `knownManifests` cleared (they read the pinned manifest); a bundle whose sealed manifest differs from what the plugin's code answers is refused; and two racing first calls to a plugin's storage apply its migrations once.

| Binding | Value |
|---|---|
| `PLUGIN_BUNDLES` | Each plugin id pinned to its bundle's sha |
| `PLUGIN_SECRETS` | `{ "example": { "PING_TOKEN": "ping-secret-8f2d" } }`, the shared-account path |
| `PLUGIN_SECRET_FIXTURE_CARRIER__API_KEY` | A miniflare `secretsStoreSecrets` binding (store `0123…cdef`, secret `PLUGIN_FIXTURE_CARRIER_API_KEY`), the own-account path; `beforeAll` seeds it with `adminSecretsStore(...).create('sk-store-AAAA')` |
| `PLUGIN_GRANTS` | Buyer details for `fixture-carrier` |
| `outboundService` | `carrierUpstream` in `vitest.config.ts`: `api.carrier.test/rates` answers one option titled with the last four characters of the `Authorization` it was sent; `*.allowed.test` answers `ok <authorization or "no auth">` and `/redirect` redirects to `evil.test`; anything else is `599` |

`beforeAll` also puts each bundle in `DOCS` as `plugins/<id>/<sha>.json` (what CI's **Publish
sandboxed plugins** step does) and publishes the flows the tests run. The tests:

| Test | Covers |
|---|---|
| installed from its pin | `pluginStatuses` lists both plugins with `runtime: 'sandboxed'`, healthy, and deep health passes `plugin_example` and `plugin_fixture_carrier` |
| env | The plugin's env holds exactly `PLUGIN_KEY`, `SECRETS`, `STORAGE` and the SDK's `__ORDERLOOP_SANDBOX` flag: no engine binding |
| storage and compensation | A node writes to its own `PluginStorage` (read back with `PLUGIN_STORAGE.query`), and `compensate` undoes it when the order fails |
| events | It receives the outbound events it subscribed to |
| pages | `EngineApi.pluginFetch` answers `401` with no principal and `200` with one signed with the plugin's key, and `404` for an id that isn't installed |
| secrets | A secret marked `expose` is readable by the plugin (the example's `PING_TOKEN` gates `/public/ping`: `401` without it, `200` with `Bearer ping-secret-8f2d`); one declared `inject` is not: `PluginSecrets` says `has` but `get` returns `null` |
| injection and rotation | An order rated through the carrier (`commerce.shipping_rate` with provider `fixture-carrier`) reaches `api.carrier.test` with the key from the Secrets Store as `Authorization` (`key AAAA`); updating the secret in the store (`adminSecretsStore(...).update`) shows `key BBBB` on the next order, with no reload |
| egress | https to a host in `egress` works with no credential; an undeclared host, `http:`, a private address and a redirect to a host outside `egress` are each a `403` the plugin sees, with the reason |
| scrubbing | A secret a node writes into its failure message, or throws, reaches the timeline as `[redacted]`; the tail handler's exception row in `plugin_errors` is scrubbed too |
| the pin | A bundle whose bytes don't hash to the pin is refused (`doesn't match its pin`) |
| `limitsFor` | The per-call caps by kind (200 ms and 20 subrequests for a call, 1,000 ms for a page), with a manifest's `limits` lowering but never raising them |
| `egressRefusal` | Loopback, link-local, CGNAT, unique-local, IPv4-mapped IPv6 (both spellings), the metadata hostname, wildcard-DNS names and URLs with credentials are refused even when `egress` would allow them |

Local workerd does not enforce Worker Loader's `limits`, so `limitsFor` is tested as a function. Not
every local workerd delivers a Dynamic Worker's tail events to its `tails` handler (CI's does, so a
thrown attempt's exception lands in `plugin_errors` there), so the scrubbing test also calls the
`PluginTail` entrypoint's `tail()` with hand-made trace items, as the runtime would, and asserts
every row is scrubbed. Egress is tested through the loader, because `globalOutbound` is
enforced locally.

### Runtime installs

The `installs` project (`tests/installs/installs.test.ts`) installs the fixture carrier the way an
admin does, from a signed `.olplugin`, with nothing pinned by the registry. `vitest.config.ts` makes
a publisher key pair (`generateKeyPairSync('ed25519')`), lists its public key as `acme` in
`PLUGIN_PUBLISHERS`, hands the private key to the tests as `TEST_PUBLISHER_JWK`, and builds the
carrier twice into `TEST_INSTALL_BUNDLES`: version 1, and a version 2 sealed from the same code with
its version changed. `outboundService` is the same `carrierUpstream` as `sandboxed`. The tests sign
each file themselves (WebCrypto Ed25519), so they can also sign it wrongly, and run in order:

| Test | Covers |
|---|---|
| refuses a bundle the deployment can't trust | Off without `PLUGIN_PUBLISHERS`; not a bundle; a test fixture without `PLUGIN_TEST_FIXTURES`; a publisher not listed; another key's signature; a `sha` that isn't the body's; a signed version that isn't the manifest's; a sealed manifest the code doesn't answer (the dry run); an id the registry pins. Nothing is recorded |
| runs a reviewed, approved install | A pending upload isn't installed (`validateGraph` names it); approve is refused without the buyer-details grant; a secret not declared is refused, and a set one is sealed in `plugin_secrets`; once approved, its status is `source: 'installed'`, an order rates through it with the admin's secret injected at egress (`key 1111`), and the list says the secret is set without its value; with the registry pinning its own `fixture-carrier`, the admin's secret isn't served |
| upgrades, rolls back, and disables | Uploading a pending bundle again answers with its review; a second approval is refused, and so is an upload of an approved bundle; a rollback is refused once its publisher is no longer listed; approving version 2 supersedes 1; rolling back reverses that; off, it isn't installed; on again, it is |
| reseals its secrets | `resealSecrets` moves `plugin_secrets` to a new `DATA_KEY` |
| uninstalls only once nothing uses it | Refused while a published flow uses it; then its rows are `uninstalled`, its secrets deleted and its storage wiped |
| installs again after an uninstall | Two versions uploaded at once, both pending; two approvals racing leave exactly one version running |

`scripts/fleet.test.ts` covers `pluginInstalls` (names and keys validated, rendered as
`PLUGIN_PUBLISHERS`, absent when not set) and signs a bundle with `scripts/plugin-pack.ts` that
core's `verifyBundleSignature` accepts. `packages/core/tests/plugins.test.ts` (`signed bundles`)
covers the signing message, a good signature, a tampered one and another key's, and the file schema.
`apps/web/tests/step-up.test.ts` covers `stepUp` itself (over a fake D1): a two-factor code taken once (the same code again refused) and a password not enough for someone with two-factor sign-in; a password otherwise, unless single sign-on only is on; a sign-on within ten minutes for someone with neither; five wrong tries throttled; and a token refused. `apps/web/tests/plugin-installs.test.ts` covers the Plugins page's actions: approve, roll back and
uninstall, and turning a plugin on, each refused without a step-up (the engine not called, the refusal audited), as is replacing a running plugin's secret, approve
passing the admin's grant, an engine refusal shown as it is, a secret set without a step-up and its
value never in the audit log, and unknown actions or ids. `apps/web/tests/api.test.ts` (`installing
plugins over REST`) covers `POST /api/v1/plugins` (`201` and audited, a refusal `400` with its
reason, over 5 MiB `413` before the engine sees it, admins only; there is no approve endpoint) and
`POST /api/v1/plugins/{id}/disable` (a registry plugin's refusal is `400`). `apps/web/tests/plugins.test.ts` checks a plugin page's `form-action` is its own `/plugins/<id>/`.

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
| aliases | A GTIN claimed as an EAN-13 is found by its GTIN-14 too, and a second product claiming it in the other length is refused; a SKU another product holds is refused with `already used by <key>` and a slug the refused product claimed first is given back; the SKU is free once its holder drops it; a claim whose product no longer holds it (a release that never happened) is taken over |
| shard batches | A batch id is applied once (a repeat with different rows returns the first results and stores nothing new); a shard refuses to be called as another shard number |
| urgent purges | Three urgent products on one shard send one `PURGE` message carrying their three `p:<key>` tags (the shard's `PURGE` binding replaced by a spy through `runInDurableObject`) |
| unpublishing | A draft's documents, cards and alias pointers are deleted while it still owns its SKUs, and come back when it is active again; a dropped variant's pointer goes; deleting a product removes its documents and claims, and an unknown key is `unchanged`; an alias pointer deleted behind the publisher's back is put back by the product's next publish |
| types, channels and categories | Types add versions only (a removed attribute is refused with a reason, a new type must start at 1) and an unversioned product pins to the latest; categories with an unknown parent or a cycle are refused and the published tree has localized names; a channel whose default locale isn't published is refused |

`apps/catalog/tests/publish.test.ts` runs `publishKeys` against a stand-in shard (one product, its `published` rows in memory) with the real R2 and KV and the shard doing its own writes: a deleted product's cards (every locale) and its `u:f1:<key>` entry are removed; a key created anew under a new uid rewrites its uid entry and deletes every card under the old uid; and a pass whose KV writes fail after its documents are stored, followed by the product's deletion, is taken down in full by the next pass (documents in every locale and alias pointers).

`apps/catalog/tests/publisher.test.ts` covers `CatalogPublisher`'s pieces: `publisherOf` sends a key to the same publisher every time and spreads 8,000 keys over 8 publishers within 150 of an even split, and `runOps` runs R2 and KV puts (with content type and `version` metadata) and deletes. The rest of the catalog suite publishes through the publishers (the default fanout of 32, real objects in workerd), so `settle()` and every published-object assertion also cover the shard-to-publisher path.

`apps/catalog/tests/deletes.test.ts` covers the deletes: a type products use is refused with a count and an unused one loses every version (an unknown one is refused); a category with products or with children outside the set is refused, and leaves and their parent delete together; a channel's delete takes down its documents, alias pointers, cards and category tree and leaves other channels alone.

The writing-products group also checks the `u:f1:<key>` uid entry in KV, and its second write is
urgent (`putProducts(…, { urgent: true })`) so the alarm's purge send runs; only the urgent-purges
group reads what is sent.

### Listing indexes

`apps/catalog/tests/listings.test.ts` uses the real shards, the `CHANGES` queue (local, consumed by the Worker's `queue` handler) and `ListingIndexer`. `listing(category, n)` waits for the category's 8 segment indexers to hold `n` members between them, runs each one's alarm by hand (`runDurableObjectAlarm`), decodes each segment's `idx/` object from R2 with `ListingIndex` once its `members` metadata matches its indexer (a segment without members has none) and queries them together with `queryListing`.

| Test | Covers |
|---|---|
| ancestors | A product is listed in its category and every ancestor, with facets and sorts in the index |
| segments | 24 products in one category land each in its key's segment only, more than one segment is built, and pages of five over all of them hold every product once |
| moving | A product moved between categories leaves the old listing (through `left`) and enters the new; one that stops being listed is dropped |
| ordering | The latest change by `at` wins when changes arrive out of order |
| build pacing | `debounceMs` (15 s up to 300,000 members, a second per 20,000 beyond, at most 5 minutes); inside the indexer (`runInDurableObject`, `LISTING_DELAY_MS` set to `0`), the next build is due `debounceMs(members)` after the last; a change with the stored entry signature only moves `at` and doesn't set `dirty`, while an older one changes nothing and a new price does; a `forced` (reindex) change with the same entry, through `applyChanges` (to the key's segment), sets `dirty` |
| sending changes | `sendChanges` packs 3,000 changes into messages of at most `CHANGES_MESSAGE_BYTES` and `sendBatch` calls of at most 100 messages and 256 KB, in order; `changesIn` reads a single-change message from before packing |
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
| `principal.test.ts` | `principal()` looks a session up once per Request (the shell's and the page's loaders share it), again for another Request such as a `.data` fetch, and again after a failed lookup; a stale session's `last_seen_at` is written once, after the response (`afterResponse`), and a recent one not at all |
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
| `catalog-api.test.ts` | `/api/v1/catalog` against a mocked `ProductCatalogRpc` (`~/lib/env.server`'s `catalog()`): an operator's product write is forwarded with `by` and `urgent` and audited with the created, updated, unchanged and rejected counts; a viewer can't write, a malformed body and 501 products are `400` and never reach the catalog; reads and alias lookups for a viewer, `404` when unknown; deletes; a type the catalog refuses is `409` with its reasons; channels and categories; deleting types, channels (`admin` only) and categories, `404` when unknown and `409` when refused, each audited; a feed file streamed to `startFeed` with `202`; `reindex` for an admin only; anything else is `404` |
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

`scripts/fleet.test.ts` also covers plugin runtimes and secrets: a `sandboxed` plugin gets no Worker, service binding or `d1Id` (`workerPlugins`, `sandboxedPlugins`; `renderPlugin` refuses it; a `d1Id` or an unknown `runtime` is refused); the reserved ids (`bundles`, `secrets`, `grants`, `key`, `publishers`) and ids with a double or trailing dash are refused; with a `secretsStore`, `renderEngine` binds each sandboxed plugin's listed secrets as `PLUGIN_SECRET_<ID>__<NAME>` from the store and `renderPlugin` binds a Worker plugin's under `<NAME>` (a bad `storeId` or secret name is refused); a shared account binds no store; and `missingPluginSecrets` finds the required secrets a deployment lacks, by name only (from the environment, or from the registry's list and the store's names).

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
| batches | Cards in the order asked, `null` for unknown keys, a repeated key once; a strong `etag` of the body and a `304` (with `FRESH`, no body) for a matching weak or strong `If-None-Match`, another key order another `etag`; a product whose uid changed (old card deleted, new uid in KV) is found again; no `keys`, 101 keys or a malformed key is `400` (`at most 100 keys`) |
| the gateway | `POST` is `405`; `OPTIONS` is `204` allowing `if-none-match`; a wrong version prefix or unknown kind is `404`; a bad channel, locale or slug is `400`; `/health` is `{ ok: true }` |
| purging | A queue batch with a repeated tag acknowledges every message, with no wait since `purge` skipped; `drain` with a fake clock and purge: whole messages packed into calls of at most 100 deduplicated tags (a 250-tag message split), `PURGE_PACE_MS` after each call; an hour-old message is still purged, and past `PURGE_CALLS` calls the rest is retried at once; a refused call retries the messages it hadn't covered and keeps the purged one acknowledged |

`apps/catalog-edge/tests/listing.test.ts` writes listing indexes split into segments by `listingSegment` (each built with core's `buildListingIndex`; five products in `tees`, so some segments have no object, and 300 with many ties in `many`) and their cards, and requests `categories/<code>/products` through the gateway:

| Group | Covers |
|---|---|
| pages | Newest first with `total` and a segmented `next` cursor, facets over the whole result with labels, range `min`, `max` and buckets, across segments some of which don't exist |
| filters and sorts | Term and range filters, price sorts, facet counts that stay disjunctive |
| refusals | A sort the index lacks, bad filters, ranges, cursors (negative, numeric, the wrong number of positions, leading zeros, upper case) and limits (`400`) and an unknown category (`404`) |
| ETags | A page's strong `etag` and a `304` (keeping `cache-tag`) when `If-None-Match` names it or is `*`; another page, or a changed card under the same index, another `etag` |
| the internal path | `/_idx/…` is not reachable through the gateway; through `Delivery` itself a segment is served with its `etag` and `content-length` and revalidates to a `304`, and an empty segment, one out of range or a malformed path is `404` |
| held listings | With `INDEX_LIMITS` shrunk and `forgetListings` between tests: empty segments are held, so a product added to one isn't seen until revalidation (then it is); with a 1-byte budget a listing is kept whole while the other listing is evicted, and revalidating returns the same decoded segments (all `304`), the held bytes matching the segments'; a listing whose segments add up to more than `max`, though each fits, is `503` and not held |
| merging | For `newest` and both price sorts, with no filter, a term filter and a term and range filter, pages of 7 followed to the end are exactly the brute-force order, `total` on every page; facet counts summed over segments |
| cache keys | Equivalent pages (filter order, value order, default `sort`, the first page's `cursor` and `limit` spelled out) have one canonical URL; any other cursor keeps its spelling |

`apps/catalog-edge/tests/search.test.ts` requests `search` through the gateway. The catalog is a stub Worker named `orderloop-catalog`, defined in `vitest.config.ts` (miniflare `workers`) and answering only `tee` (uids 7, 70 and 71), so the service binding resolves without Durable Objects:

| Group | Covers |
|---|---|
| matching | Cards in match order, with `total` and `next` paging |
| exact SKU | A one-word query that is a product's SKU puts that product first |
| refusals | A query without a word and a `cursor` at or past `SEARCH_DEPTH` are `400` |
| cache keys | Equivalent queries (case, spacing, default `cursor` and `limit` spelled out) have one canonical URL |

Workers Caching isn't emulated locally, so these tests check what reaches the cache (canonical URLs,
headers, `304`s) and not hits, misses, stale serving or tag purges: `Delivery.purge` is a no-op
without it, so the queue test checks the acknowledgements and `drain` is tested with a fake purge. Nothing in the repository tests those; the
deploy's smoke test requests only `/health`, which the gateway answers without the cache.

## The Claude Code toolkit

`pnpm test:toolkit` checks `.claude/` (see `.claude/README.md`), in bash, with `jq` and git:

| Script | Covers |
|---|---|
| `.claude/scripts/toolkit-check.sh` | Each skill's name matches its directory and the Agent Skills rules (lowercase-hyphen, at most 64 characters, a description of at most 1,024), `SKILL.md` under 500 lines and its `references/` links resolving; each agent's name matches its file and every skill it preloads exists and can be preloaded; every hook in `settings.json` is an executable script that parses; the rules and surface maps have their columns and every regex compiles |
| `.claude/hooks/tests/docs-hooks.test.sh` | `docs-impact` naming pages once per file per session, `docs-drift` counting only the session's uncommitted edits, `block-generated` denying `theme.css` and `worker-configuration.d.ts` |
| `.claude/hooks/tests/guard-hooks.test.sh` | `guard-bash` denying deploys, rollbacks, remote migrations, Time Travel restores and resource deletes (also chained after another command) and asking before pushing `main`, force pushes, `gh pr merge`, remote D1 SQL, Worker secrets and provisioning; `guard-invariants` denying an edit to a migration already on `origin/main` (a throwaway repo), the vendored UCP schemas and z-suffixed routes, and asking before the routing golden test; `rules-impact` once per file; `format` fixing and reporting through Biome; `session-context` in a plain checkout and a worktree |

CI runs it in the verify job.

## Evals

The unit tests run AI nodes in `AI_MODE=mock`, so they never judge a model. The evals do:
`apps/engine/evals/` runs a golden set through the real prompt code (`extractOrder`, `route` and
`riskScore` in `apps/engine/src/ai.ts`) against the live models named in the `vars` of
`apps/engine/wrangler.jsonc`.

| Task | Cases (`evals/cases.ts`) | A case passes when |
|---|---|---|
| `extract` | 5: plain SKUs, products by name, an order form, an item not in the catalog (left out), an injection attempt in the email (data, not a command) | The model answered (not the heuristic), the lines match (SKU and quantity, any order) and, where the case names one, the PO number matches |
| `router` | 4: a routine order, a large order, no customer account, a steering note in `meta` | The model answered and chose the route the instructions give |
| `risk` | 3: a known customer in credit, a guest's very large first order, a customer far over their limit | The model answered and the score is in the band: low is below 40, high is 60 or more |

A task passes at 80% of its cases (`PASS_RATE` in `evals/ai.eval.ts`). An answer from the heuristic
fallback counts as a failure: the eval measures the model. Every run prints a table of each case's
result and answer, and appends it to the GitHub run summary when `GITHUB_STEP_SUMMARY` is set.

- **Run.** `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @orderloop/engine evals`.
  It uses `apps/engine/vitest.evals.config.ts` (`evals/**/*.eval.ts`, Node environment, five-minute
  timeout), not workerd. `evals/live-env.ts` builds an `Env` whose `AI.run` calls the Workers AI REST
  API, with `AI_MODE=live`, `AI_PERSONAL_DATA=redact` and no AI Gateway, so evals don't spend
  production's rate limit. Without both variables the suite skips with a message. It is not part of
  `pnpm test`.
- **In CI.** `.github/workflows/evals.yml`; see [Deploy](deploy.md#ai-evals). It is never a required
  check, because a model is not deterministic: a failure is a reason to look.
- **Add a case.** When a model gets something wrong in production, add an unambiguous case to
  `evals/cases.ts` (`EXTRACT`, `ROUTER` or `RISK`), so a failure means the model, not the case.
  The extract catalog is the demo data's.
- **Change a model or a prompt.** Run the evals and read the table first, and bump the prompt's
  version in `AI_PROMPTS` ([AI calls](architecture.md#ai-calls)).

## What isn't covered

The flow editor canvas and the live order page are not under test; verify UI changes by running
`pnpm web:dev` and driving a scenario. See [Getting started](local-development.md).
