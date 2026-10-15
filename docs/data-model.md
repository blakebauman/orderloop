# Data model

The D1 tables, the migrations that create them, and where order documents live in R2.

Both Workers bind the same D1 database (`orderloop`, binding `DB`) and R2 bucket
(`orderloop-docs`, binding `DOCS`). The Drizzle schema is `packages/db/src/schema.ts`; the SQL that
creates it is `packages/db/migrations/*.sql`.

:::caution
`schema.ts` must match the migrations column for column and index for index. To change the schema, add a new numbered
migration and update `schema.ts` to match; never edit a migration that has been applied.
:::

D1 holds indexes and the back office. An order's live run state is not in D1: it lives in its
[OrderAgent](order-agent.md), and its durable progress in its Workflow instance.

## Migrations

| File | Adds |
|---|---|
| `0001_init.sql` | Flows, versions, the orders index, approvals and the mock back office |
| `0002_seed.sql` | Demo customers, products and contract prices (removed by `0027`; flows are seeded by the engine from the templates) |
| `0003_webhook_subscriptions.sql` | `webhook_subscriptions`, `webhook_deliveries` |
| `0004_order_idempotency.sql` | `orders.idempotency_key` and its partial unique index |
| `0005_idempotency_fingerprint.sql` | `orders.idempotency_fingerprint`: a replayed key must carry the same request |
| `0006_stock_movements.sql` | `stock_movements`, the inventory ledger |
| `0007_inbound_emails.sql` | `inbound_emails`, the email intake log |
| `0008_node_runs.sql` | `node_runs`, per-node timing for the dashboard |
| `0009_price_chain.sql` | `price_sources` and `price_rules`, the pricing chain, with demo entries (the rules removed by `0027`) |
| `0010_fx_rates.sql` | `fx_rates` with demo rates (EUR, GBP and CAD removed by `0027`), and `orders.fx_rate` |
| `0011_users.sql` | `users`, `sessions` and `api_tokens`, for roles and sign-in |
| `0012_auth_failures.sql` | `auth_failures`, counts for throttling failed sign-ins |
| `0013_audit_events.sql` | `audit_events`, the audit log |
| `0014_token_expiry.sql` | `api_tokens.expires_at` |
| `0015_session_activity.sql` | `sessions.last_seen_at`, `ip`, `user_agent` |
| `0016_two_factor.sql` | `users.totp_secret`, `totp_enabled_at`, `totp_last_step`; `recovery_codes` and `sign_in_challenges` |
| `0017_workspace_settings.sql` | `workspace_settings`, settings admins change in the app |
| `0018_order_models.sql` | Renames `flows.order_type`, `orders.type` and `node_runs.order_type` to `model`; adds `flows.channels`, `orders.channel`, `external_id` and `contact_email`, and `customers.kind`; replaces index `orders_type` with `orders_model` and adds `orders_channel_external` |
| `0019_marketplace.sql` | `sellers`, `seller_orders`, `payouts` and `products.seller_id` |
| `0020_fulfillment.sql` | `locations`, `location_stock`, `entitlements`; `products.kind`, `reservations.location_id`, `stock_movements.location_id`; two demo stores, digital products and store stock |
| `0021_balance_entries.sql` | `balance_entries`, the receivables ledger |
| `0022_store_coordinates.sql` | `locations.latitude` and `longitude`, seeded for both demo stores; `loc_mission` now ships |
| `0023_order_waiting_at.sql` | `orders.waiting_at` and `waiting_since`, where an order waits and since when |
| `0024_password_change_due.sql` | `users.password_change_due`, set while a person is on a temporary password |
| `0025_webhook_receipts.sql` | `webhook_receipts`, signatures of delivered signed events, for replay protection |
| `0026_query_indexes.sql` | Indexes: `orders(created_at)`, `orders(updated_at)`, `node_runs(ended_at)`, `payments(status, created_at)`, `customers(lower(email))`, `sessions(expires_at)`, `webhook_deliveries(created_at)` |
| `0027_remove_demo_data.sql` | Data only. Removes the demo data the migrations above seeded (demo customers except `cus_internal`, the catalog, sellers, stores and their stock, contract prices, price rules, and the EUR, GBP and CAD rates) and every order placed against a demo customer or SKU, with its approvals, documents, payments, node runs and other rows. Keeps `cus_internal`, the three `price_sources` and the `USD` rate |
| `0028_integrations.sql` | `integrations`, one signing key per external system, replacing the single `WEBHOOK_SECRET` |
| `0029_order_started_by.sql` | `orders.started_by`: the principal id that started the order (null for channels, email and the stock review) |
| `0030_stripe_payments.sql` | `payments.provider` (default `mock`, so existing rows read as mock), `external_id` (index `payments_external`) and `currency`; `customers.stripe_customer_id` (unique partial index `customers_stripe_customer`) and `stripe_payment_method_id` |
| `0031_invoices_payment_events.sql` | `invoices` (Stripe invoices issued by `commerce.invoice`) and `payment_events` (Stripe event ids already handled, kept 30 days) |
| `0032_passkeys.sql` | `passkeys` and `passkey_challenges` |
| `0033_flow_published_by.sql` | `flow_versions.published_by`, who published each version as the audit trail names them (null for built-in templates and older versions) |
| `0034_audit_chain.sql` | `audit_events.seq` (unique index `audit_events_seq`), `prev_hash` and `hash`: the hash chain; triggers `audit_events_no_update` (no `UPDATE`) and `audit_events_keep_90_days` (no `DELETE` of an event younger than 90 days). Earlier events stay unsealed |

Apply them with `pnpm db:migrate:local`, or `pnpm --filter @orderloop/web db:migrate:remote` before
deploying code that needs them. The engine's tests apply the same directory to their D1 on start.

### Demo data

Migrations carry no demo data from `0027` on, so a fresh or production database has none: only `cus_internal`,
the price sources and the `USD` rate. The demo data lives in `packages/db/seed/0001_demo.sql` (`INSERT OR IGNORE`).
`pnpm db:seed:local` loads it into the local D1 after `pnpm db:migrate:local`, and the engine tests load it after
the migrations. Without it only `USD` orders are accepted; any other currency gets the `400` unsupported-currency
error until its rate is added to `fx_rates`.

## Flows

| Table | Purpose | Key columns |
|---|---|---|
| `flows` | One row per flow; `graph_json` is the editable draft | `id`, `name`, `description`, `model`, `channels` (JSON array), `published_version` |
| `flow_versions` | Immutable published snapshots; primary key `(flow_id, version)`, cascades with the flow | `flow_json`, `published_at`, `published_by` (nullable: the audit trail's name for who published it) |

`publishFlow` (`packages/db/src/flows.ts`) saves the draft and inserts the next version, numbering and inserting it in one statement so racing publishes get consecutive versions; seeding passes `unlessPublished`, which inserts nothing when the identical content is already a version. It takes `{ publishedBy }`, stored in `flow_versions.published_by`.
`getFlowVersionJson` loads a given version or the latest. Orders pin `(flow_id, flow_version)` at
start, so editing or republishing never changes a running order. The built-in templates are
published as a new version whenever their content has not been published before: version 1 the
first time they are needed, the next version after a template changes (`ensureTemplates` in the
engine, `ensureSeeded` in the web app; see [Templates](https://docs.orderloop.app/guides/templates/#seeding)).

## Orders and approvals

| Table | Purpose | Key columns |
|---|---|---|
| `orders` | The orders index for lists, filters and the dashboard. Written by `startOrder` and then by the agent's `syncIndex` | `id`, `model`, `channel`, `external_id`, `contact_email`, `status`, `title`, `flow_id`, `flow_version`, `instance_id`, `generation`, `customer_id`, `currency`, `total`, `waiting_on`, `waiting_at`, `waiting_since`, `idempotency_key`, `idempotency_fingerprint`, `fx_rate` (the order's rate, set when it is priced), `started_by` (the principal id that started it: set by the web app for New order, a demo scenario, an editor test run, a restart and `POST /api/v1/orders`, and by the engine for A2A `place_order`; null for channel webhooks, Shopify, EDI, email intake and the stock review; from `StartOrderInput.startedBy`, never a request body, and not in the fingerprint) |
| `approvals` | One row per approval wait, for the approvals inbox | `order_id`, `node_id`, `event_type`, `title`, `assignee`, `amount`, `status`, `decided_by`, `note` |

Indexes: `orders_status (status, updated_at)`, `orders_model (model, updated_at)`,
`orders_channel_external (channel, external_id)` where `external_id` is not null, and
`orders_idempotency`, unique on `idempotency_key` where it is not null. `startOrder` inserts the
row before creating anything else, so when two requests race with the same `Idempotency-Key` the
unique index decides which one creates the order and the other returns it as `replayed`.
`idempotency_fingerprint` is the SHA-256 of the request (for a signed inbound order, of the sender's
payload, so routing changes don't affect it); a replay with a different one is refused.
Rows from before `0005` have none and replay without the check.

`approvals.status` is `pending`, then the outcome (`approved`, `rejected`, `escalated`) or
`cancelled`. Approvals are indexed by `(status, requested_at)`, and `approvals_wait` makes
`(order_id, event_type)` unique, so a retried `:open` step cannot insert a second row.

## Back office

The tables the [connectors](architecture.md#connectors) read and write. Every id a step
writes embeds its step key.

| Table | Purpose |
|---|---|
| `customers` | `kind` (`business`, `consumer` or `internal`), `tier`, `credit_limit`, `balance` (open receivables, raised by invoicing an unpaid business order, once per step through `balance_entries`), payment `terms`; `stripe_customer_id` (unique when set; created once per account, idempotency key `cust_${customerId}`) and `stripe_payment_method_id` (the card a `verify` authorization saved, which `commerce.charge` uses off-session) |
| `products` | Primary key `sku`; `price`, `cost`, `stock`, `reserved` (central stock), `reorder_point`, `reorder_qty`, `supplier`, `seller_id` (null means the operator sells it), `kind` (`physical` or `digital`; digital products hold no stock) |
| `sellers` | Marketplace sellers: `name`, `email`, `commission_pct` (a fraction), `auto_accept`, `active`. See [Marketplace](https://docs.orderloop.app/guides/marketplace/) |
| `seller_orders` | One row per order and seller, id `so_${orderId}_${sellerId}` (first party is `first_party`): `status` (`pending`, `accepted`, `rejected` or `cancelled`), `lines` (JSON), `subtotal`, `reason`, `decided_at` |
| `payouts` | One row per order, seller and payout step: `gross`, `commission`, `refunded`, `net`; `status` is `scheduled`, `reversed` or `paid` |
| `contract_prices` | Negotiated prices, primary key `(customer_id, sku)`: the pricing chain's contract source |
| `price_sources` | The pricing chain: `id` (`price_book`, `contract`, `volume`), `label`, `priority` (lowest runs first), `stop_processing`, `active`. See [Pricing chain](https://docs.orderloop.app/reference/expressions/#pricing-chain) |
| `fx_rates` | Units of each `currency` per one USD (`BASE_CURRENCY` in `@orderloop/core`), with `updated_at`. `USD` is the only row in a migrated database; the demo seed adds EUR 0.92, GBP 0.79 and CAD 1.37. No UI edits them yet (the back office lists them), so add a rate with SQL. See [Currency](https://docs.orderloop.app/reference/expressions/#currency) |
| `price_rules` | Price-book and volume entries: `source_id`, `name`, optional scope (`sku`, `customer_id`, `customer_tier`, `min_qty`, `starts_at`, `ends_at`), and a fixed `price` or `discount_pct` off list |
| `locations` | Stores that hold their own stock: `name`, `kind` (`store`), `postal_code`, `latitude` and `longitude` (nullable; for shipping from the nearest store), `pickup` (customers can collect there) and `ships` (it can fulfil shipped orders). Seeded: `loc_soho` and `loc_mission`, both pickup and ships. See [Fulfillment](https://docs.orderloop.app/guides/fulfillment/) |
| `location_stock` | A store's stock per SKU, primary key `(location_id, sku)`: `stock` and `reserved` |
| `entitlements` | A code per unit of a digital line (licence key, download, gift card): `order_id`, `sku`, `code`, `status` (`issued` or `revoked`), `created_at` |
| `reservations` | Stock holds, id `res_${orderId}_${stepKey}_${line}_${sku}`; `status` is `held`, `released`, `consumed` (by shipping or a hand-over) or `restored` (the shipment was cancelled and the consumed stock returned). `location_id` is `NULL` for central stock (`products`) and the store's id otherwise; each line holds at its own location, so a split shipment has holds at several |
| `stock_movements` | The inventory ledger: one row per step, line and `kind` (`hold`, `restock`, `release` or `consume`), with `qty` and `applied`. A movement is recorded and applied to `products`, or to `location_stock` when its `location_id` is set, in one D1 batch, and only while `applied` is false, so a retried step changes stock once. Release and consume are keyed by the reservation (`release_${reservationId}`, `consume_${reservationId}`) and apply only if their reservation row made the move from `held`, so a cancel racing a rollback, or a release racing a consume, settles each reservation once. A hold is written only while the stock is still free, so of two orders racing for the last units one is short; restoring shipped stock is a `restock` keyed `unconsume_${reservationId}` |
| `balance_entries` | The receivables ledger: one row per order and step that billed a customer on account, with `amount` (base currency) and `applied`. Recorded and applied to `customers.balance` in one D1 batch, only while `applied` is false, so a retried invoice step bills once. Reversing an order's charges (the `commerce.invoice` rollback, or a cancel) writes a negative entry per charge, id `rev_${entryId}`, once; a paid Stripe invoice settles its charge with `set_${entryId}` instead. Whichever comes first applies, in the same batch that checks the other is absent, so a charge comes off the balance once |
| `invoices` | Invoices issued through Stripe (`commerce.invoice` with provider `stripe`), id `inv_${orderId}_${stepKey}`, written before Stripe is called. `provider` is `stripe`, or `mock` on the simulated gateway; `status` `pending` (nothing confirmed in Stripe) → `draft` → `open` → `paid` or `void`. `external_id` is the Stripe invoice (`in_…`, unique), with `number`, `hosted_url` (the hosted invoice page), `amount`, `currency`, `terms`, `due_at` (the due date asked for, so a retried step repeats the same request), `balance_entry_id` (the account charge it made) and `paid_at`. See `apps/engine/src/billing.ts` |
| `payments` | Authorizations (`kind` `authorization:<method>`; `status` `authorized`, `verified`, `declined`, `captured` or `voided`), captures, charges, refunds and `invoice_payment`s (a paid Stripe invoice, id `ipay_${invoiceId}`, `ref` the invoice row), with `status` and `ref` (a capture's authorization, a refund's payment, a decline's reason). `provider` is `mock`, `stripe`, `external` (the channel took the money) or `offline` (cash, terms, a till); `external_id` is the Stripe PaymentIntent (`pi_…`) or Refund (`re_…`), indexed as `payments_external`; `currency` is the order's. The row id is also the Stripe `Idempotency-Key`. See `apps/engine/src/payments.ts` |
| `shipments` | Labels, return labels and store hand-overs; `status` is `label_created`, `return_label`, `ready_for_pickup` (a staged pickup: carrier `pickup`, `tracking` is the pickup code), `collected` (carrier `pickup` or `carry_out`) or `cancelled` |
| `documents` | Index of R2 objects per order: `kind`, `r2_key`, `content_type` |
| `messages` | The mock outbox for `commerce.notify`: recipient, subject, body |

`reservations`, `stock_movements`, `entitlements`, `payments`, `shipments`, `documents`, `messages`, `seller_orders` and `payouts` are each indexed by
`order_id` (`<table>_order`), which is how compensation and the order page find an order's rows. `payouts` also has `payouts_seller (seller_id, created_at)`, `balance_entries` is indexed by `balance_entries_customer (customer_id, created_at)` (it has no `order_id` index), and `price_rules` by `price_rules_source (source_id)`.

## Metrics

| Table | Purpose |
|---|---|
| `node_runs` | One row per finished node run, primary key `(order_id, generation, node_id, run)`: `node_type`, `model`, `status` (`succeeded` or `failed`), `started_at`, `ended_at`, `duration_ms`. Written by the OrderAgent (see [Node timing](order-agent.md#node-timing)) and indexed by `(node_type, ended_at)` and `ended_at`; rows older than 180 days are deleted by the [retention sweep](#retention) |

The dashboard's **Last 30 days** section (`apps/web/app/lib/metrics.server.ts`) aggregates in D1 at
request time: completion rate by model from `orders` (completed over finished, by
`created_at`), p50 and p95 duration per node type from `node_runs` (nearest rank, with window
functions), revenue per day from completed `orders`, and refund rate from `payments` (succeeded
`refund` over succeeded `capture` and `charge`). Money is converted to USD at each order's
`fx_rate`.

## People and tokens

| Table | Purpose |
|---|---|
| `users` | `email` (unique, lowercased), `name`, `role` (`viewer`, `approver`, `operator`, `admin`), `password_hash` (PBKDF2, `pbkdf2:<iterations>:<salt>:<hash>`), `external_sub` (unique when set; reserved for an outside identity provider's subject), `last_login_at`, `disabled_at`, and for [two-factor sign-in](https://docs.orderloop.app/guides/team-and-roles/#two-factor-sign-in) `totp_secret` (base32), `totp_enabled_at` and `totp_last_step` (the last 30-second step a code was accepted for, so a code works once), and `password_change_due` (the password was set by an operator; see [temporary passwords](https://docs.orderloop.app/guides/team-and-roles/#temporary-passwords)) |
| `sessions` | One per signed-in browser: `token_hash` (SHA-256 of the `__Host-ol_session` cookie), `user_id`, `expires_at` (30 days), `last_seen_at` (null means `created_at`; updated at most every 5 minutes, and a session idle 7 days has ended), `ip` and `user_agent` (for the Account page). Expired sessions are deleted by the [retention sweep](#retention) |
| `recovery_codes` | One-use two-factor recovery codes: `code_hash` (SHA-256 of the code, lowercased without the dash), `user_id`. A row is deleted when its code is used |
| `sign_in_challenges` | A correct password waiting for its two-factor code: `token_hash` (SHA-256 of the `__Host-ol_2fa` cookie), `user_id`, `expires_at` (10 minutes). Deleted on success; expired rows are dropped at the next sign-in |
| `passkeys` | WebAuthn credentials, public keys only: `id` (credential id, base64url), `user_id`, `public_key` (COSE, base64url), `counter` (signature counter; a counter that goes backwards fails verification), `transports` (JSON), `name` (up to 60 characters), `backed_up` (synced), `created_at`, `last_used_at`. Index on `user_id`. An admin's two-factor reset deletes a person's rows |
| `passkey_challenges` | A registration or passkey sign-in waiting for its answer: `id` (SHA-256 of the `__Host-ol_pk` cookie, or `reg:<user id>`), `challenge`, `user_id`, `expires_at` (5 minutes). Single use |
| `api_tokens` | `name`, `prefix` (the first 12 characters, for lists), `token_hash` (SHA-256 of the `ol_live_` token, unique), `role`, `created_by`, `last_used_at` (updated at most every 5 minutes), `revoked_at`, `expires_at` (always set for new tokens, 30 days to 1 year; null, on tokens made before expiry existed, never expires). For an expired token, `last_used_at` limits its `api.token_expired` audit events to one an hour |
| `auth_failures` | Failed attempts per `key` (`email-ip:`, `ip:`, `email:` for sign-in; `setup-ip:` for wrong setup codes; `two-factor:<user id>` for wrong codes; `reauth:<user id>` for wrong current passwords on the Account page) with `count` and `window_start`; a 15-minute fixed window, and rows a day old are dropped. See [Failed sign-ins](https://docs.orderloop.app/guides/team-and-roles/#failed-sign-ins) |
| `webhook_receipts` | Delivered signed events: `id` (`event:<integration id>:<signature>`) and `received_at`, indexed by `received_at`. A repeat of a recorded signature is answered as a duplicate; rows older than 10 minutes are pruned as new ones are written (and by the [retention sweep](#retention)). See [Signed events](https://docs.orderloop.app/reference/rest-api/#signed-events) |
| `workspace_settings` | Settings admins change in the app: `key`, `value`, `updated_at`, `updated_by`. `two_factor_required` is `off`, `admin`, `operator`, `approver` or `viewer` (`operator` when the row is absent; `DEFAULT_TWO_FACTOR`), the lowest role that must use [two-factor sign-in](https://docs.orderloop.app/guides/team-and-roles/#requiring-it). `approval_separation` (`APPROVAL_SEPARATION_KEY` in `packages/core/src/roles.ts`) is `on` or `off` (the default, also when the row is absent): with `on`, the principal in `orders.started_by` can't decide that order's approvals (`ownOrderRefusal`) |
| `audit_events` | The audit log, security and business events (`apps/web/app/lib/audit.server.ts` for the web app; `apps/engine/src/audit.ts` writes the same rows through `auditRow` in core for the order socket, assistant, MCP and A2A): `at`, `action` (see [Audit log](https://docs.orderloop.app/guides/team-and-roles/#audit-log)), `actor`, `actor_id`, `actor_kind`, `target` (the order, flow or subscription for business events), `detail` (JSON; business events carry `via`), `ip`, and the hash chain: `seq` (unique, from 1), `prev_hash` (`genesis` for the first) and `hash` (SHA-256 over the event's fields, `seq` and `prev_hash`; `sealAuditRow` in core), all null for events written before migration 0034. Written through `appendAudit` (`packages/db/src/audit.ts`), which retries when two writers take the same `seq`. Indexed by `at`, `(action, at)` and unique `seq`. Append-only: trigger `audit_events_no_update` refuses any `UPDATE`, and `audit_events_keep_90_days` refuses a `DELETE` of an event younger than 90 days. Past the deployment's retention the engine's [retention sweep](#retention) archives events to R2 and then deletes them |

No password, token or recovery code is stored in the clear; the two-factor secret is, because
checking a code needs it. See [Team and roles](https://docs.orderloop.app/guides/team-and-roles/).

## Webhooks

| Table | Purpose |
|---|---|
| `webhook_subscriptions` | `url`, `secret` (returned once, at creation), `events` (a JSON array; `"*"` matches all), `active` |
| `integrations` | An external system that signs inbound webhooks (`POST /api/v1/webhooks/events` and `/orders`), id `int_…`: `name`, `secret` (`whsec_` and 48 hex digits; returned once, at creation and rotation), `previous_secret` and `previous_expires_at` (the secret before a rotation, accepted for 24 hours), and its scope: `events` (a JSON array; `"*"` matches all), `start_orders` (boolean), `flows` (a JSON array of flow ids an order body may name; `"*"` matches all) and `channel` (null for any). With `created_at`, `created_by`, `last_used_at` (touched on each verified request) and `revoked_at`. Revoking sets `revoked_at` and clears the previous secret; the row stays so audit entries still resolve. The signature names the row with `k=` |
| `payment_events` | Stripe events already handled, by Stripe's event id: `provider`, `type`, `order_id`, `received_at`. Claimed before the event is acted on and deleted again when the answer is `retry` or handling throws; kept 30 days by the [retention sweep](#retention), since Stripe redelivers for three |
| `webhook_deliveries` | The outbox: one row per event per subscription, id `whd_${orderId}_${stepKey}_${subscriptionId}`. `status` is `pending`, `delivered` or `failed`; with `attempts`, `response_status`, `last_error`, `delivered_at` |

Deliveries are indexed by `order_id`, `created_at` and `(subscription_id, created_at)`; delivered or failed ones older than 90 days are deleted by the [retention sweep](#retention). See
[Outbound webhooks](https://docs.orderloop.app/guides/outbound-webhooks/).

## Email intake

| Table | Purpose |
|---|---|
| `inbound_emails` | One row per message the `email()` entrypoint saw: `message_id` (unique), `mailbox`, `sender`, `subject`, `status` (`accepted`, `duplicate`, `rejected`), `reason`, `order_id`, `r2_key`, `attachments`, `received_at`. Rows older than 180 days are deleted by the [retention sweep](#retention) |

See [Email intake](https://docs.orderloop.app/guides/email-intake/#the-intake-log).

## R2 documents

`storeDocument` writes to `orders/<orderId>/<kind>/<name>` and records the same key in `documents`:

| Kind | Name | Written by |
|---|---|---|
| `inbound` | `po.txt` | `startOrder`, when the input has `documentText` and no `documentKey` |
| `email` | `message.eml` (under `inbound/`) | `receiveEmail`, the raw message an order started from |
| `invoice` | `<nodeId>-<run>.html` | `commerce.invoice` |
| `po` | `<nodeId>-<run>.html` | `commerce.generate_po` |

The web app serves them at `/docs/<key>` to signed-in users only.

## Personal data

Where personal data is stored, and where it goes. Order Loop holds no data about anyone beyond what
a customer's orders, team and mail bring in; a deployment holds only one customer's.

| Where | What | Notes |
|---|---|---|
| `customers` | `name`, `email`; `stripe_customer_id`, `stripe_payment_method_id` | Indexed by `lower(email)` |
| `sellers` | `name`, `email` | Marketplace sellers |
| `orders` (D1) | `contact_email` (a guest buyer's email), `title`, `external_id` | `title` is free text and can name a person. Orders are kept (see [Retention](#retention)) |
| OrderAgent state | The whole `Order`: `contact` (`email`, `name`, `phone`), `meta` (including `meta.shipTo`, the ship-to address, and any other key a caller sends), `title`, `documentText`, and the run's `vars` and node outputs | Durable Object storage, one per order. See [OrderAgent](order-agent.md#state) |
| R2 | `orders/<orderId>/inbound/po.txt` (the inbound document), `inbound/message.eml` (the raw email) | Served at `/docs/<key>` to signed-in users only. See [R2 documents](#r2-documents) |
| `inbound_emails` | `sender`, `subject` | Deleted after 180 days; the `.eml` in R2 is not |
| `messages` | `recipient`, `subject`, `body` | The `commerce.notify` outbox |
| `webhook_deliveries` | `payload`, the event JSON sent to a subscriber | Deleted after 90 days once delivered or failed |
| `users` | `email`, `name`, `password_hash`, `totp_secret` | The team |
| `sessions` | `ip`, `user_agent` | Deleted when expired |
| `audit_events` | `actor` (an email, `token:<name>` or `operator`), `target` (can be a person's email), `detail`, `ip` | Archived to R2 after `AUDIT_RETENTION_DAYS`, then deleted |
| `auth_failures` | `key` (`email-ip:`, `ip:`, `email:` prefixes) | Dropped after a day |

`payments`, `shipments`, `invoices` and the ledgers hold ids, amounts and tracking numbers, not
names or addresses (`invoices.hosted_url` leads to the Stripe-hosted page).

### To the model

Workflow AI nodes (Classify, Risk score, Agent router, Summarize, Assess) and the assistant's
`assess_order` send the model `modelContext(mode, …)` from `packages/core/src/redact.ts`
(`modelView` in `apps/engine/src/ai.ts`). The mode is the engine's `AI_PERSONAL_DATA`
(`personalDataMode`): `redact`, the default, or `send`.

With `redact`:

- **Order**: `id`, `model`, `channel`, `customerId`, each line's `sku`, `name`, `qty`, `unitPrice`
  and `sellerId`, `subtotal`, `shipping`, `shippingOption`, `tax`, `total`, `baseTotal`,
  `currency`, `fulfillment.method` only, `guest` (no `customerId`, but a `contact`) and
  `shipToCountry` (two letters, from `meta.shipTo`).
- **Title** with emails and phone numbers masked as `[email]` and `[phone]` (`maskPersonalText`: a
  run of at least nine digits, so dates and amounts stay).
- **`meta`, `vars` and completed steps' outputs** through `scrubPersonal`: values under keys
  such as `name`, `email`, `phone`, `address`, `shipTo`, `billTo`, `contact`, `buyer`, `city`,
  `zip`, `postalCode` and `street` (any depth; case, `_` and `-` ignored) are dropped, and emails and
  phone numbers in other strings are masked. The key list is `PERSONAL_KEYS`.
- **Customer** (Risk score, Agent router, and Assess with `state` `order_and_context`): `id`,
  `kind`, `tier`, `creditLimit`, `balance` and `terms`. No name or email.

With `send`, the order also carries `contact`, the unmasked `title` and `meta`, the customer gains
`name` and `email`, and `vars` and step outputs are sent as they are.

Never sent in either mode: `documentText`, payment ids, Stripe ids, `fxRate`, `taxRate` and other
bookkeeping. The Agent router's `instructions` and Assess's `instructions` are the flow author's
text and go as written.

Not covered by the redaction:

- **Extract order** sends the inbound document text (first 20,000 characters) whole; finding the
  buyer in it is its job.
- **The assistant's chat tools** return order data to the assistant model for the signed-in person
  asking, as that person's role may see it.
- **The copilot** sends flow graphs, not order data.

### To AI Gateway and logs

- **AI Gateway** records every model call. With request logs on (the registry's `aiGatewayLogs`,
  default `true`) it keeps the prompts and responses, up to 100,000 entries. Turning logs off is
  set at creation by `provision.sh`; for an existing gateway it is changed in the dashboard.
- **Workers logs** are on for both Workers (`observability` in `wrangler.jsonc`, invocation logs
  included). Every audit event is also written as one `{"type":"audit_event",…}` JSON line
  (`apps/web/app/lib/audit.server.ts`, `apps/engine/src/audit.ts`), carrying `actor`, `target`, `detail` and `ip`; these lines
  outlive the D1 retention and are subject to Cloudflare's log retention instead.

## Retention

A daily sweep (`sweep` in `apps/engine/src/retention.ts`, run by the engine's `scheduled()` handler on the cron `30 3 * * *`, UTC) deletes, in one batch (audit events are archived first, see below):

| Table | Deleted when |
|---|---|
| `sessions` | `expires_at` has passed |
| `webhook_deliveries` | not `pending` and older than 90 days |
| `node_runs` | `ended_at` older than 180 days |
| `inbound_emails` | `received_at` older than 180 days |
| `webhook_receipts` | `received_at` older than 10 minutes |
| `payment_events` | `received_at` older than 30 days |

Orders and everything in an order's record (payments, invoices, shipments, the stock and balance ledgers, flow versions) are kept.

`audit_events` is not pruned on write. The sweep moves events older than `AUDIT_RETENTION_DAYS` (default 400, at least 90; `auditRetentionDays` in core) to the `DOCS` R2 bucket (`archiveAudit`): one NDJSON object per batch of up to 1,000 events (one event a line, hashes included) at `audit/<yyyy-mm-dd>/<at>-<id>.ndjson`, at most 50,000 events a run, each batch deleted only after its object is written. Events from before the chain go first, by time; sealed events go in `seq` order and stop at the first one still within the retention, so what remains is an unbroken chain. The sweep reports the count as `auditArchived`.
