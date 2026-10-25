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
| `0035_order_erased_at.sql` | `orders.erased_at`: when a [data subject erasure](#personal-data) removed the buyer from the order; later requests skip it |
| `0036_action_confirmations.sql` | `action_confirmations` (one-time codes for [MCP actions](architecture.md#mcp)) and index `action_confirmations_expires` |
| `0037_ai_usage.sql` | `ai_usage` (model tokens per person per day for the assistant) and index `ai_usage_day` |
| `0038_scim.sql` | `users.scim_external_id`, `scim_groups` and `scim_group_members` (index `scim_group_members_user`), for SCIM provisioning |
| `0039_ucp.sql` | `ucp_platforms`, `checkout_sessions` and `ucp_idempotency`, for [agentic checkout](architecture.md#ucp-agentic-checkout) |
| `0040_webhook_rotation.sql` | `webhook_subscriptions.previous_secret` and `previous_expires_at`, for outbound secret rotation |
| `0041_order_index_where.sql` | `orders.waiting_for`, `stopped_at` and `reason`, so the orders list can say who a wait is on and where and why an order ended |
| `0042_flow_archived.sql` | `flows.archived_at`: a never-published draft archived out of the flows list |
| `0043_products_catalog_at.sql` | `products.catalog_at` (nullable, ms): when the product catalog last set the row's name and price |
| `0044_balance_entries_order.sql` | Index `balance_entries_order (order_id)`, for reversing an order's account charges |
| `0045_shipments_provider.sql` | `shipments.provider` and `external_id`: the provider plugin that labelled a shipment and its own id for the label |
| `0046_plugin_errors.sql` | `plugin_errors` and its index `plugin_errors_plugin (plugin_id, at)` |
| `0047_plugin_installs.sql` | `installed_plugins` (and its index `installed_plugins_status (status)`) and `plugin_secrets`, for plugins an admin installs at runtime |
| `0048_carts_promotions.sql` | `carts` (the Carts index; unique `carts_session (plugin_id, session_ref)` where `plugin_id` is set), `promotions` (unique `promotions_code`) and `promotion_redemptions` |
| `0049_plugin_drafts.sql` | `installed_plugins.request` and `cases`, for plugins the assistant drafts, and the unique index `installed_plugins_version (id, version)` |
| `0050_cart_retention.sql` | `carts.buyer_id` (index `carts_buyer` where set) and `purged_at` (index `carts_purge` with `updated_at`), for data subject requests and the retention sweep |
| `0051_product_dimensions.sql` | `products.weight_kg`, `length_cm`, `width_cm` and `height_cm` (nullable), for weight and dimensional-weight shipping rates |
| `0052_confirmation_bound.sql` | `action_confirmations.bound`, what a code is held to besides its input (a cart's version for `submit_cart`) |
| `0053_session_reauth.sql` | `sessions.reauth_at` (nullable), for a single sign-on step-up |
| `0054_api_token_creator.sql` | `api_tokens.created_by_id`, backfilled from `created_by` |
| `0055_temporary_password_expiry.sql` | `users.password_expires_at` (nullable): when a temporary password stops working |
| `0056_product_vectors.sql` | `product_vectors`: what the product index (Vectorize) holds per SKU; empty until the engine's first reindex |
| `0057_product_index_lease.sql` | `product_index_lease`: the one lease a product index reindex holds while it runs |

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
| `flows` | One row per flow; `graph_json` is the editable draft | `id`, `name`, `description`, `model`, `channels` (JSON array), `published_version`, `archived_at` (a never-published draft archived out of the flows list; null otherwise) |
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
| `orders` | The orders index for lists, filters and the dashboard. Written by `startOrder` and then by the agent's `syncIndex` | `id`, `model`, `channel`, `external_id`, `contact_email`, `status`, `title`, `flow_id`, `flow_version`, `instance_id`, `generation`, `customer_id`, `currency`, `total`, `waiting_on`, `waiting_at`, `waiting_since`, `waiting_for` (what the open waits are on: `person:<role>`, `event:<name>` or `timer`, joined with ` · `), `stopped_at` and `reason` (for an order that failed, rolled back, was declined or cancelled: the failed steps' labels and why), `idempotency_key`, `idempotency_fingerprint`, `fx_rate` (the order's rate, set when it is priced), `erased_at` (set by `eraseDataSubject`; null otherwise), `started_by` (the principal id that started it: set by the web app for New order, a demo scenario, an editor test run, a restart and `POST /api/v1/orders`, and by the engine for A2A `place_order`; null for channel webhooks, Shopify, EDI, email intake and the stock review; from `StartOrderInput.startedBy`, never a request body, and not in the fingerprint) |
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
| `products` | Primary key `sku`; `price`, `cost`, `stock`, `reserved` (central stock), `reorder_point`, `reorder_qty`, `supplier`, `seller_id` (null means the operator sells it), `kind` (`physical` or `digital`; digital products hold no stock), `catalog_at` (ms; when the product catalog last set the row's `name` and `price`, null for rows it never wrote; see [Product catalog](#product-catalog)), `weight_kg`, `length_cm`, `width_cm`, `height_cm` (per-unit shipping weight and size, null when unknown; read by `commerce.shipping_rate` under the `weight` and `dim_weight` bases) |
| `product_vectors` | Primary key `sku`; `name` (the name its vector was embedded from), `indexed_at` (ms). One row per SKU the product index (Vectorize `PRODUCT_VECTORS`) holds, written after the vector is. The engine's hourly reindex (`apps/engine/src/product-index.ts`) embeds the `products` rows missing here or renamed since, and deletes the vectors and rows of SKUs no longer in `products`, so it catches every writer of `products` (the catalog, seeds, the demo reset) without hooking them. An admin's **Update product index** (Commerce page) runs the same reindex now |
| `product_index_lease` | One row (`id` 1) while a product index reindex runs: `holder` (a random id per run) and `expires_at` (ms, 15 minutes on). A run takes it in one statement (`INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now`), answers `busy` when another holds it, and deletes its own row when it ends, so the hourly cron and an admin's run never overlap |
| `sellers` | Marketplace sellers: `name`, `email`, `commission_pct` (a fraction), `auto_accept`, `active`. See [Marketplace](https://docs.orderloop.app/guides/marketplace/) |
| `seller_orders` | One row per order and seller, id `so_${orderId}_${sellerId}` (first party is `first_party`): `status` (`pending`, `accepted`, `rejected` or `cancelled`), `lines` (JSON), `subtotal`, `reason`, `decided_at` |
| `payouts` | One row per order, seller and payout step: `gross`, `commission`, `refunded`, `net`; `status` is `scheduled`, `reversed` or `paid` |
| `contract_prices` | Negotiated prices, primary key `(customer_id, sku)`: the pricing chain's contract source |
| `price_sources` | The pricing chain: `id` (`price_book`, `contract`, `volume`), `label`, `priority` (lowest runs first), `stop_processing`, `active`. See [Pricing chain](https://docs.orderloop.app/reference/expressions/#pricing-chain) |
| `fx_rates` | Units of each `currency` per one USD (`BASE_CURRENCY` in `@orderloop/core`), with `updated_at`. `USD` is the only row in a migrated database; the demo seed adds EUR 0.92, GBP 0.79 and CAD 1.37. No UI edits them yet (the Commerce page lists them), so add a rate with SQL. See [Currency](https://docs.orderloop.app/reference/expressions/#currency) |
| `price_rules` | Price-book and volume entries: `source_id`, `name`, optional scope (`sku`, `customer_id`, `customer_tier`, `min_qty`, `starts_at`, `ends_at`), and a fixed `price` or `discount_pct` off list |
| `locations` | Stores that hold their own stock: `name`, `kind` (`store`), `postal_code`, `latitude` and `longitude` (nullable; for shipping from the nearest store), `pickup` (customers can collect there) and `ships` (it can fulfil shipped orders). Seeded: `loc_soho` and `loc_mission`, both pickup and ships. See [Fulfillment](https://docs.orderloop.app/guides/fulfillment/) |
| `location_stock` | A store's stock per SKU, primary key `(location_id, sku)`: `stock` and `reserved` |
| `entitlements` | A code per unit of a digital line (licence key, download, gift card): `order_id`, `sku`, `code`, `status` (`issued` or `revoked`), `created_at` |
| `reservations` | Stock holds, id `res_${orderId}_${stepKey}_${line}_${sku}`; `status` is `held`, `released`, `consumed` (by shipping or a hand-over) or `restored` (the shipment was cancelled and the consumed stock returned). `location_id` is `NULL` for central stock (`products`) and the store's id otherwise; each line holds at its own location, so a split shipment has holds at several |
| `stock_movements` | The inventory ledger: one row per step, line and `kind` (`hold`, `restock`, `release` or `consume`), with `qty` and `applied`. A movement is recorded and applied to `products`, or to `location_stock` when its `location_id` is set, in one D1 batch, and only while `applied` is false, so a retried step changes stock once. Release and consume are keyed by the reservation (`release_${reservationId}`, `consume_${reservationId}`) and apply only if their reservation row made the move from `held`, so a cancel racing a rollback, or a release racing a consume, settles each reservation once. A hold is written only while the stock is still free, so of two orders racing for the last units one is short; restoring shipped stock is a `restock` keyed `unconsume_${reservationId}` |
| `balance_entries` | The receivables ledger: one row per order and step that billed a customer on account, with `amount` (base currency) and `applied`. Recorded and applied to `customers.balance` in one D1 batch, only while `applied` is false, so a retried invoice step bills once. Reversing an order's charges (the `commerce.invoice` rollback, or a cancel) writes a negative entry per charge, id `rev_${entryId}`, once; a paid Stripe invoice settles its charge with `set_${entryId}` instead. Whichever comes first applies, in the same batch that checks the other is absent, so a charge comes off the balance once |
| `invoices` | Invoices issued through Stripe (`commerce.invoice` with provider `stripe`), id `inv_${orderId}_${stepKey}`, written before Stripe is called. `provider` is `stripe`, or `mock` on the simulated gateway; `status` `pending` (nothing confirmed in Stripe) → `draft` → `open` → `paid` or `void`. `external_id` is the Stripe invoice (`in_…`, unique), with `number`, `hosted_url` (the hosted invoice page), `amount`, `currency`, `terms`, `due_at` (the due date asked for, so a retried step repeats the same request), `balance_entry_id` (the account charge it made) and `paid_at`. See `apps/engine/src/billing.ts` |
| `payments` | Authorizations (`kind` `authorization:<method>`; `status` `authorized`, `verified`, `declined`, `captured` or `voided`), captures, charges, refunds and `invoice_payment`s (a paid Stripe invoice, id `ipay_${invoiceId}`, `ref` the invoice row), with `status` and `ref` (a capture's authorization, a refund's payment, a decline's reason). `provider` is `mock`, `stripe`, `external` (the channel took the money) or `offline` (cash, terms, a till); `external_id` is the Stripe PaymentIntent (`pi_…`) or Refund (`re_…`), indexed as `payments_external`; `currency` is the order's. The row id is also the Stripe `Idempotency-Key`. See `apps/engine/src/payments.ts` |
| `shipments` | Labels, return labels and store hand-overs; `status` is `label_created`, `return_label`, `ready_for_pickup` (a staged pickup: carrier `pickup`, `tracking` is the pickup code), `collected` (carrier `pickup` or `carry_out`), `cancelled`, or `void_failed` (a provider's label it couldn't void yet; retried daily by `retryLabelVoids`). `provider` and `external_id` (migration `0045`) name the provider plugin that made the label and its id for it, null for built-in shipments ([Plugins](plugins.md#providers)) |
| `documents` | Index of R2 objects per order: `kind`, `r2_key`, `content_type` |
| `messages` | The mock outbox for `commerce.notify`: recipient, subject, body |

`reservations`, `stock_movements`, `entitlements`, `payments`, `shipments`, `documents`, `messages`, `seller_orders` and `payouts` are each indexed by
`order_id` (`<table>_order`), which is how compensation and the order page find an order's rows. `payouts` also has `payouts_seller (seller_id, created_at)`, `balance_entries` is indexed by `balance_entries_customer (customer_id, created_at)` and `balance_entries_order (order_id)`, and `price_rules` by `price_rules_source (source_id)`.

## Metrics

| Table | Purpose |
|---|---|
| `node_runs` | One row per finished node run, primary key `(order_id, generation, node_id, run)`: `node_type`, `model`, `status` (`succeeded` or `failed`), `started_at`, `ended_at`, `duration_ms`. Written by the OrderAgent (see [Node timing](order-agent.md#node-timing)) and indexed by `(node_type, ended_at)` and `ended_at`; rows older than 180 days are deleted by the [retention sweep](#retention) |

The **Performance** page (`apps/web/app/routes/performance.tsx`, data from `performance` in
`apps/web/app/lib/metrics.server.ts`) aggregates in D1 at request time over one window of 7, 30
or 90 whole UTC days ending today (`?days=`, `toRange`, 30 by default; `windowStart`), so every
figure on it counts the same orders and payments. **Day by day** (`apps/web/app/components/trends.tsx`)
charts `daily` (`fillDays`, one row per UTC day so empty days still show): revenue from completed
`orders`; orders ended per day by `updated_at`, stacked as completed, declined or cancelled, and
failed or rolled back; and money collected and refunded from succeeded `payments` by
`created_at`. **Over the period** (`apps/web/app/components/performance.tsx`) shows completion
rate by model (completed over ended in the window), refund rate from `totals` (the sums of the
daily series, so a figure can't disagree with its chart) and p50 and p95 duration per node type from
`node_runs` (nearest rank, with window functions). Money is converted to USD at each order's
`fx_rate`. The page shows counts instead of a completion rate below five ended orders per model,
and a step's 95th percentile only from 20 runs. The charts use `@orderloop/ui/chart` (shadcn's
Chart over Recharts), colored with the existing Ledger tokens.

The overview (`overview` in `apps/web/app/lib/orders.server.ts`, one D1 batch) reads the orders
index: open counts by status; orders that ended in the last 24 hours by status, with the completed
total and how many were declined; open waits grouped by `flow_id`, `waiting_at` and
`waiting_for` with the oldest `waiting_since`; and the last 7 days' failed and rolled-back orders
grouped by `flow_id` and `stopped_at`, with the latest `reason`. `waitTrails` and `stoppedSteps`
(`apps/web/app/lib/where.ts`) lay those along each flow's steps, ordered as the flow's published
version draws them (`flowSteps` in `apps/web/app/lib/flows.server.ts`). Its links open the orders
list filtered by `step` (`waiting_at` or `stopped_at`) and `within` (`24h` or `7d` of
`updated_at`).

## People and tokens

| Table | Purpose |
|---|---|
| `users` | `email` (unique, lowercased), `name`, `role` (`viewer`, `approver`, `operator`, `admin`), `password_hash` (PBKDF2, `pbkdf2:<iterations>:<salt>:<hash>`, or `pbkdf2p:<pepper id>:<iterations>:<salt>:<hash>` over HMAC-SHA256 of the password with `PASSWORD_PEPPER`, the id naming which pepper made it; an unpeppered one is stored again peppered at the next sign-in), `external_sub` (unique when set; the OpenID Connect subject of the person's single sign-on identity, set when `decideSso` links them by verified email on their first sign-in or creates them; a person created that way has no `password_hash`), `last_login_at`, `disabled_at`, and for [two-factor sign-in](https://docs.orderloop.app/guides/team-and-roles/#two-factor-sign-in) `totp_secret` (base32, [encrypted](operations.md#rotating-the-data-key)), `totp_enabled_at` and `totp_last_step` (the last 30-second step a code was accepted for, so a code works once), `scim_external_id` (the provider's id for the person, as SCIM sent it), and `password_change_due` (the password was set by an operator; see [temporary passwords](https://docs.orderloop.app/guides/team-and-roles/#temporary-passwords)), `password_expires_at` (when such a temporary password stops working, 7 days after it was set; cleared when the person chooses their own) |
| `scim_groups`, `scim_group_members` | Groups an identity provider pushes over SCIM (`id` `grp_…`, `display_name`, `external_id`, `created_at`, `updated_at`) and their members (`group_id`, `user_id`, primary key together, both cascading on delete; index on `user_id`). Admins map groups to roles in the workspace setting `scim_roles` |
| `sessions` | One per signed-in browser: `token_hash` (SHA-256 of the `__Host-ol_session` cookie), `user_id`, `expires_at` (30 days), `last_seen_at` (null means `created_at`; updated at most every 5 minutes, and a session idle 7 days has ended), `ip` and `user_agent` (for the Account page), `reauth_at` (when its person last signed in again at the identity provider for a step-up; null until then). Expired sessions are deleted by the [retention sweep](#retention) |
| `recovery_codes` | One-use two-factor recovery codes: `code_hash` (SHA-256 of the code, lowercased without the dash), `user_id`. A row is deleted when its code is used |
| `sign_in_challenges` | A correct password waiting for its two-factor code: `token_hash` (SHA-256 of the `__Host-ol_2fa` cookie), `user_id`, `expires_at` (10 minutes). Deleted on success; expired rows are dropped at the next sign-in |
| `passkeys` | WebAuthn credentials, public keys only: `id` (credential id, base64url), `user_id`, `public_key` (COSE, base64url), `counter` (signature counter; a counter that goes backwards fails verification), `transports` (JSON), `name` (up to 60 characters), `backed_up` (synced), `created_at`, `last_used_at`. Index on `user_id`. An admin's two-factor reset deletes a person's rows |
| `passkey_challenges` | A registration or passkey sign-in waiting for its answer: `id` (SHA-256 of the `__Host-ol_pk` cookie, or `reg:<user id>`), `challenge`, `user_id`, `expires_at` (5 minutes). Single use |
| `api_tokens` | `name`, `prefix` (the first 12 characters, for lists), `token_hash` (SHA-256 of the `ol_live_` token, unique), `role`, `created_by` (the maker's email, or name), `created_by_id` (the maker's user id, so disabling or demoting them revokes it; filled from `created_by` for older tokens, null when no person matched), `last_used_at` (updated at most every 5 minutes), `revoked_at`, `expires_at` (always set for new tokens, 30 days to 1 year; null, on tokens made before expiry existed, never expires). For an expired token, `last_used_at` limits its `api.token_expired` audit events to one an hour |
| `auth_failures` | Failed attempts per `key` (`email-ip:`, `ip:`, `email:` for sign-in; `setup-ip:` for wrong setup codes; `two-factor:<user id>` for wrong codes; `reauth:<user id>` for wrong current passwords on the Account page) with `count` and `window_start`; a 15-minute fixed window, and rows a day old are dropped. See [Failed sign-ins](https://docs.orderloop.app/guides/team-and-roles/#failed-sign-ins) |
| `webhook_receipts` | Delivered signed events: `id` (`event:<integration id>:<sha256 of "<t>.<body>">`: what was signed, so the same delivery is one receipt however its signature is spelled and whichever secret it was signed with during a rotation) and `received_at`, indexed by `received_at`. A repeat of a recorded signature is answered as a duplicate; rows older than 10 minutes are pruned as new ones are written (and by the [retention sweep](#retention)). See [Signed events](https://docs.orderloop.app/reference/rest-api/#signed-events) |
| `workspace_settings` | Settings admins change in the app: `key`, `value`, `updated_at`, `updated_by`. `two_factor_required` is `off`, `admin`, `operator`, `approver` or `viewer` (`operator` when the row is absent; `DEFAULT_TWO_FACTOR`), the lowest role that must use [two-factor sign-in](https://docs.orderloop.app/guides/team-and-roles/#requiring-it). `approval_separation` (`APPROVAL_SEPARATION_KEY` in `packages/core/src/roles.ts`) is `on` or `off` (the default, also when the row is absent): with `on`, the principal in `orders.started_by` can't decide that order's approvals (`ownOrderRefusal`). `sso` is JSON `{ jitRole, domains, ssoOnly }` (`SsoSettings` in `apps/web/app/lib/sso.ts`; absent or unreadable is `jitRole: null`, no domains, `ssoOnly: false`): the role a person not on the team joins with on their first single sign-on (null refuses them) from the listed email domains, and whether passwords and passkeys are refused. Redeeming a setup code sets `ssoOnly` back to `false`. `scim_token` is the SHA-256 of the SCIM bearer token (`ol_scim_…`; absent means SCIM is off; `updated_by` is the admin who made it). `scim_roles` is JSON `{ <scim_groups.id>: role }`, the role each pushed group gives (`readRoleMap` drops unreadable entries). `ucp` is JSON `{ checkoutFlowId, links, orderUrl }` (`UcpSettings`, `ucpSettingsSchema` in `packages/core/src/ucp/profile.ts`; absent or unreadable is off, `checkoutFlowId: null`): the flow a completed [agentic checkout](architecture.md#ucp-agentic-checkout) starts, the legal links every checkout shows and the order link template |
| `audit_events` | The audit log, security and business events (`apps/web/app/lib/audit.server.ts` for the web app; `apps/engine/src/audit.ts` writes the same rows through `auditRow` in core for the order socket, assistant, MCP and A2A): `at`, `action` (see [Audit log](https://docs.orderloop.app/guides/team-and-roles/#audit-log)), `actor`, `actor_id`, `actor_kind`, `target` (the order, flow or subscription for business events), `detail` (JSON; business events carry `via`), `ip`, and the hash chain: `seq` (unique, from 1), `prev_hash` (`genesis` for the first) and `hash` (SHA-256 over the event's fields, `seq` and `prev_hash`; `sealAuditRow` in core), all null for events written before migration 0034. Written through `appendAudit` (`packages/db/src/audit.ts`), which retries when two writers take the same `seq`. Indexed by `at`, `(action, at)` and unique `seq`. Append-only: trigger `audit_events_no_update` refuses any `UPDATE`, and `audit_events_keep_90_days` refuses a `DELETE` of an event younger than 90 days. Past the deployment's retention the engine's [retention sweep](#retention) archives events to R2 and then deletes them |

No password, token or recovery code is stored in the clear; the two-factor secret is, because
checking a code needs it. See [Team and roles](https://docs.orderloop.app/guides/team-and-roles/).

Ending access is one helper, `endAccess` (`apps/web/app/lib/access.server.ts`): it deletes a person's `sessions` (all, or all but the browser asking), revokes their OAuth grants (every page of `listUserGrants`) and has the engine drop the A2A push configs they registered (`EngineRpc.dropA2aPushes`), revokes the `api_tokens` they made (by `created_by_id`, or by `created_by` for a null id; all, or only those with a role above a given one) and deletes their `passkeys`, each only when asked, and returns the counts for the audit entry. Disabling (Team page or SCIM) ends sessions, grants and tokens; demoting revokes tokens above the new role (grants follow the role through `grantPrincipal`); an admin's password reset and a two-factor reset end sessions, grants and passkeys; changing your own password revokes your grants (the route ends your other sessions). A SCIM group change that lowers someone's role revokes their tokens above it too, and SCIM ties tokens still matched by `created_by` to the person's id before it changes their email. `createToken` re-reads its maker after the insert and revokes the new token if they were disabled or are no longer an admin.

## Webhooks

| Table | Purpose |
|---|---|
| `webhook_subscriptions` | `url`, `secret` (returned once, at creation and rotation; stored encrypted, bound to the row), `previous_secret` and `previous_expires_at` (the secret before a rotation, which also signs deliveries for 24 hours, `ROTATION_GRACE_MS`), `events` (a JSON array; `"*"` matches all), `active` |
| `integrations` | An external system that signs inbound webhooks (`POST /api/v1/webhooks/events` and `/orders`), id `int_…`: `name`, `secret` (`whsec_` and 48 hex digits; returned once, at creation and rotation; stored encrypted), `previous_secret` and `previous_expires_at` (the secret before a rotation, accepted for 24 hours), and its scope: `events` (a JSON array; `"*"` matches all), `start_orders` (boolean), `flows` (a JSON array of flow ids an order body may name; `"*"` matches all) and `channel` (null for any). With `created_at`, `created_by`, `last_used_at` (touched on each verified request) and `revoked_at`. Revoking sets `revoked_at` and clears the previous secret; the row stays so audit entries still resolve. The signature names the row with `k=` |
| `action_confirmations` | One-time codes for actions over MCP (`apps/engine/src/confirmations.ts`): `id` (`cfm_` and 32 hex characters), `principal_id` (who it was issued to), `tool`, `input_digest` (`fingerprintOf({ tool, input })`, so key order is ignored), `created_at`, `expires_at` (5 minutes, `CONFIRMATION_TTL_MS`), `used_at` and `bound` (JSON the server held the code to besides its input, such as `{ "cartVersion": 4 }` for `submit_cart`, handed back when it is used; null otherwise). A code is used by one `UPDATE` that matches caller, tool, digest, unused and unexpired, so two calls can't both run. Indexed by `expires_at`; rows expired over a day are deleted by the [retention sweep](#retention) |
| `ai_usage` | Assistant model tokens per person per UTC day (`apps/engine/src/usage.ts`), primary key `(principal_id, day)`: `principal_id`, `day` (`2026-10-17`), `tokens`, `calls`. Written when a turn finishes (`totalUsage.totalTokens`), read before the next to refuse once `ASSISTANT_DAILY_TOKENS` is reached. Indexed by `day`; days older than 90 are deleted by the [retention sweep](#retention) |
| `payment_events` | Stripe events already handled, by Stripe's event id: `provider`, `type`, `order_id`, `received_at`. Claimed before the event is acted on and deleted again when the answer is `retry` or handling throws; kept 30 days by the [retention sweep](#retention), since Stripe redelivers for three |
| `webhook_deliveries` | The outbox: one row per event per subscription, id `whd_${orderId}_${stepKey}_${subscriptionId}`. `status` is `pending`, `delivered` or `failed`; with `attempts`, `response_status`, `last_error`, `delivered_at`. A plugin subscribed to the event gets a row too, with `subscription_id` `plugin:<id>` (no `webhook_subscriptions` row), delivered over its service binding; [Plugins](plugins.md) |
| `plugin_errors` | A sandboxed plugin's latest exceptions (`PluginTail` in `apps/engine/src/plugin-host.ts`, from its Dynamic Worker's tail events), id a random UUID: `plugin_id`, `message` (`<name>: <message>`, scrubbed of the plugin's secrets and cut at 2,000 characters) and `at` (ms). After each batch of tail events the plugin's rows beyond the newest 100 are deleted, so there is no sweep. Read by the Plugins page (`listPluginErrors`, ten newest); a Worker plugin's exceptions aren't recorded here. The tests also drive the handler directly, since not every local workerd delivers a Dynamic Worker's tail events (CI's does). Scrubbing targets credentials, not personal data, and data-subject export and erasure don't read this table: a plugin's exception text must not carry buyer details (its rows are capped at 100 and replaced as it fails) |
| `installed_plugins` | Sandboxed plugins an admin installed at runtime ([Plugins](plugins.md#installing-at-runtime)), one row per uploaded version, keyed `(id, sha)`: `version`, `publisher` (its name in the registry's `pluginInstalls`), `manifest` (the sealed manifest, JSON), `status` (`pending`, `active`, `disabled`, `superseded` or `uninstalled`; at most one `active` or `disabled` per id, kept so in code by `apps/engine/src/plugin-installs.ts`), `personal_data_granted` (the admin's grant of buyer details, 0 or 1), `uploaded_by`/`uploaded_at` and `approved_by`/`approved_at` (user ids, ms). The bundle itself is in R2 at `plugins/<id>/<sha>.json`. Rows are never deleted: an uninstalled plugin's stay, for the record. For a plugin the assistant drafted (publisher `assistant`), `request` is the admin's instruction and `cases` its test cases with their last results (JSON); both are null for an uploaded file. No personal data |
| `plugin_secrets` | Secrets an admin entered for a runtime-installed plugin, keyed `(plugin_id, name)`: `value` sealed with `DATA_KEY` (context `plugin_secrets:<plugin>:<name>`, resealed by the daily sweep), `updated_by`, `updated_at`. Write-only: the engine reads them for the plugin (`resolveSecret`), and nothing returns a value to the web app. Deleted when the plugin is uninstalled |
| `ucp_platforms` | The AI shopping platforms an admin let in (`apps/web/app/lib/ucp.server.ts`), id `ucp_…`: `name`, `profile_url` (https; must equal the profile in `UCP-Agent`), `key_prefix` (`ol_ucp_` and 4 characters, for lists), `key_hash` (SHA-256 of the key, unique; the key is returned once), `profile` and `profile_fetched_at` (the platform's profile as the engine fetched it, reused for an hour), `created_at`, `created_by`, `last_used_at` (written at most every 5 minutes) and `revoked_at`. A revoked row stays: checkouts and orders name it |
| `checkout_sessions` | Checkouts (`apps/engine/src/ucp/checkout.ts`), id `chk_…`: `owner_id` (the platform), `status`, `data` (the whole `CheckoutSession` as JSON), `order_id` (set on completion; unique where not null), `version` (compared on every write so an update can't interleave with a completion), `created_at`, `updated_at` and `expires_at`. Indexed by `(owner_id, created_at)` and `expires_at`. Sessions that never placed an order are deleted 30 days after they expire by the [retention sweep](#retention); one that did is kept, since its line ids and ship-to are what the platform's order events show |
| `ucp_idempotency` | `Idempotency-Key` replays for the UCP endpoints, primary key `(owner_id, key)`: `request_hash` (SHA-256 of the scope and the raw body), `status` and `response` (null while the first request runs) and `created_at`. A key is reusable after 24 hours; the [retention sweep](#retention) deletes rows older than 48 hours |
| `carts` | The Carts page's index (`packages/core/src/cart.ts`), id `cart_…`: `title`, `status` (`open`, `locked`, `submitted`, `returned`, `canceled`), `customer_id`, `flow_id` (the flow that prices it and that submitting starts), `order_id` (set on submit), `created_by` (a principal id, or `plugin:<id>`), `created_at`, `updated_at`, and for an external cart `plugin_id`, `session_ref` (the plugin's session id; unique with `plugin_id`) and `expires_at`. The lines, quote and chat live in the cart's CartAgent, which writes this row when the title or status changes. Chat (author id and name, free text) is in the agent's own SQLite. `buyer_id` (an external cart's buyer as the plugin named them, lower-cased, so their email for a punchout buyer whose system sends one; `''` once erased or purged, null on a staff cart or an external one not yet indexed since migration `0050`) is how a [data subject request](#export-and-erasure) finds their carts, indexed where set; `purged_at` is when the [retention sweep](#retention) cleared the ended cart (indexed with `updated_at`) Indexed by `updated_at` and `(status, updated_at)` |
| `promotions` | Promotion codes for the `commerce.discount` node, id `promo_…`: `code` (upper case, unique), `name`, `kind` (`pct`, `amount` or `free_shipping`), `value` (a percentage, or an amount in `currency`), `min_subtotal`, `skus` (a JSON array the discount is limited to, or null for every line), `customer_id` (limited to one customer), `valid_from` and `valid_to` (ms, either null for open-ended), `max_redemptions`, `per_customer_limit`, `status` (`active` or `paused`), `created_by`, `created_at`, `updated_at` |
| `promotion_redemptions` | One per promotion per order, primary key `(promotion_id, order_id)`: `customer_id`, `amount` (what the discount took off), `step_key` (the discount node's step) and `created_at`. Written inside the node's step (`redeemPromotion`, one `INSERT … SELECT` that counts the other orders' redemptions, so two orders can't both take the last one), so a retried step redeems once; never by a quote (`dryRun`); deleted when the order rolls back (`ROLLBACKS['commerce.discount']`). Counted against `max_redemptions` and, by `(promotion_id, customer_id)`, `per_customer_limit` |

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
| `inbound` | `po.txt` | `startOrder`, when the input has `documentText` and no `documentKey`. The order then keeps only the `documentKey` (in its agent's state and the Workflow's params); `ai.extract` reads the text back from R2 |
| `email` | `message.eml` (under `inbound/`) | `receiveEmail`, the raw message an order started from |
| `invoice` | `<nodeId>-<run>.html` | `commerce.invoice` |
| `po` | `<nodeId>-<run>.html` | `commerce.generate_po` |

The web app serves them at `/docs/<key>` to signed-in users only.

Cart files are at `carts/<cartId>/<attachmentId>` (`cartAttachmentKey`; `cartAttachmentPrefix` lists
a cart's), written by the web app (`apps/web/app/lib/cart-attachments.server.ts`) with the file's
type and, as custom metadata, the cart id and name. They're listed in the cart's agent
(`CartState.attachments`), not in `documents`, and served at `/carts/<cartId>/attachments/<id>` to
staff and to that cart's buyer. Removing one deletes it. A cart that ended 90 days ago loses its
files with its chat ([retention](#retention)), and a buyer's data subject request removes theirs.

## Product catalog

The catalog Worker ([Architecture](architecture.md#product-catalog)) owns no tables in D1. Its one
D1 write is to Order Loop's `products` table: a row per variant SKU with its `name`, `price` and
`catalog_at`, and its `weight_kg` and `length_cm`/`width_cm`/`height_cm` (null when the variant has none, so removing them in
the catalog clears them, and `dim_weight` shipping never bills a size the catalog no longer has), upserted by `apps/catalog/src/orders.ts` ([Order Loop's products](architecture.md#order-loops-products)).
A new row gets `cost` 0 and the column defaults; an existing row keeps everything else. `catalog_at`
is the publish change's `at`, and an upsert applies only where it is null or older, so out-of-order
queue delivery can't overwrite a newer name or price. Rows are never deleted when a product stops
listing. The catalog's own source of truth is the SQLite storage of its Durable Objects, and what it publishes goes to its own
R2 bucket (`orderloop-catalog`, not `orderloop-docs`) and KV namespace, written by `CatalogPublisher` objects (`pub-<shard>-<n>`), which keep no state of their own. Each object creates its
tables on first use (`CREATE TABLE IF NOT EXISTS`); there are no migration files for them.

`CatalogShard` (64, `shard-<n>`):

| Table | Holds |
|---|---|
| `products` | Primary key `key`; `uid` (unique, from `productUid`: the shard number and a per-shard sequence packed into 32 bits), `type`, `type_version`, `status`, `version` (starts at 1, +1 per change), `hash` (content hash), `body` (the product as JSON), `created_at`, `updated_at`, `updated_by` |
| `aliases` | `alias` (a SKU, GTIN or slug, as `productAliases` writes it: a GTIN in any length as its GTIN-14, `gtin14`) and its `owner` product key: the claims that hash to this shard (`aliasShard`), which may belong to products on other shards |
| `outbox` | `seq`, `key`, `urgent`, `rev` (the config revision the write was validated against; null for a removal or a reindex) and `forced` (1 for a reindex, whose listing changes rebuild their indexes even when no entry changed): products waiting to publish; the alarm deletes rows once their product is published. Indexed on `key`. `rev` and `forced` were added later: the constructor adds them to a table that lacks them |
| `applied` | `batch` id, `at` and the `result` of every `apply` batch, so a retried batch returns its first answer. The alarm deletes rows older than 7 days (longer than a feed part waits for redelivery). Indexed on `at` |
| `published` | Per `key` and `channel`: the locales and aliases (and the product's `uid`) last published, so a later pass can delete what is no longer published. Before a pass writes, the row holds the union of what was and what will be published (the old `uid` while one is recorded); after it, exactly what was |
| `settings` | `shard` (the number this object was first called as; a call as another number throws) and `seq` (the next `uid` sequence) |

`CatalogFeeds` (`feeds`): `feeds` (`id`, `created_at`, `body`: the `FeedStatus` as JSON, newest listed first), `chunks` (`feed`, `chunk`) and `parts` (`feed`, `part`), the last two being the keys that make recording a split chunk or an applied part idempotent. Feeds and their rows are kept; nothing deletes them.

`CatalogMeta` (`meta`): `types` (`code`, `version`, `body`, `by`, `at`; every version is kept),
`channels` and `categories` (`code`, `body`) and `settings` (`rev`, which moves on every type or
channel change). Types, channels and categories can be deleted (`DELETE` on `types`, `channels`,
`categories`), which bumps `rev` for types and channels. A channel's delete also clears its `published`
rows on every shard, and deletes its `docs/f1/<channel>/` and `idx/f1/<channel>/` objects, its KV cards
and its category trees; deleting categories deletes every segment of their listing,
`idx/f1/<channel>/<category>/<segment>.bin`, in every channel. Products keep their `channels` listing.

Published objects. `f1` is `DOC_FORMAT`, in every path so a format change is a new tree (`paths` in
`packages/core/src/product/paths.ts`):

| Where | Key | Holds |
|---|---|---|
| R2 | `docs/f1/<channel>/<locale>/p/<key>.json` | The product document for that channel and locale; custom metadata `version` |
| R2 | `docs/f1/<channel>/a/<alias, URI-encoded>` | `{ "key": "<product key>" }`: the alias pointer |
| R2 | `docs/f1/<channel>/<locale>/categories.json` | The channel's flat category tree, names in that locale |
| R2 | `idx/f1/<channel>/<category>/<segment>.bin` | One segment (`0` to `LISTING_SEGMENTS - 1`, 8 segments, `listingSegment(key)`) of the category's listing index (binary format 3, all locales' labels inside; together the segments are at most `LISTING_MAX_BYTES`, 64 MiB); custom metadata `members` and `builtAt`. A segment with no members yet has no object |
| KV | `c:f1:<channel>:<locale>:<uid in base 36>` | The listing card |
| KV | `u:f1:<key>` | The product's `uid` as a decimal string, written the first time the product publishes (and again under a new uid), deleted when the product is; `catalog-edge` turns a batch's keys into card keys with it |

`catalog-edge` ([Architecture](architecture.md#catalog-edge)) reads these objects and writes none.
It has no storage of its own besides Workers Caching, whose entries are tagged `p:<key>`,
`ch:<channel>` and `cats`, and `cat:<code>` on listing pages. The cache tags of urgent changes wait on a queue, `orderloop-catalog-purge`
(`{ tags }` messages, drained by `catalog-edge`; failed messages go to `orderloop-catalog-purge-dlq`).
Messages that reach any of the catalog's dead-letter queues are kept in the catalog's bucket at
`dlq/<queue>/<yyyy-mm-dd>/<message id>.json`, which a lifecycle rule `dlq` expires after 30 days
([Operations](operations.md#dead-letters)).

Feed files share the catalog's R2 bucket under their own prefix, `feeds/`, and expire:

| Key | Holds |
|---|---|
| `feeds/<id>/source.<csv or ndjson>` | The uploaded feed, as streamed in |
| `feeds/<id>/parts/<chunk>-<shard>.ndjson` | One chunk's validated products for one shard, a `{ row, data }` JSON object a line |

`scripts/provision.sh` adds an R2 lifecycle rule named `feeds` on that prefix that expires objects after 30 days, so a feed is retained only for as long as an import can need it (see [Operations](operations.md#adding-a-customer)).

A listing index segment is rebuilt from `ListingIndexer`, the Durable Object for one channel,
category and segment (`<channel>:<category>:<segment>`), which holds that segment's members in SQLite: `members` (`key` primary key,
`uid`, `at`, `created_at`, `live`, and `sig`, the entry's `entrySignature`, added to older tables by
the constructor; index `members_second` on `live`, the creation second descending and `uid`, the
build's order), `terms` and `nums` (`uid`, `attr`, `value`) and `settings`
(`channel`, `category`, `segment`, `dirty`, `built`, `members` at the last build, and `rev`, the highest config
revision its changes carried). A member holds the latest change by `at`; a removed
one stays as a tombstone (`live` 0) for 24 hours. A product is a member of its categories and
all their ancestors, always in its key's segment. See [Architecture](architecture.md#listing-indexes).

`SearchShard` (16, `search-<n>`, `n` from `searchShard(key)`): one FTS5 virtual table per channel and
locale, `fts_<channel>__<locale>` (non-alphanumerics in either become `_`), created on first use, with
columns `title`, `brand`, `skus`, `body` (indexed; `body` is at most `SEARCH_BODY_MAX`, 4,000
characters) and `uid` (`UNINDEXED`), tokenized `unicode61 remove_diacritics 2` with `prefix = '2 3'`.
`seen` (`key`, `channel`, `at`) holds the latest change by `at`, and a removal stays as a tombstone
that the next `apply` prunes after 24 hours when the product owns no rows; `rows` (`key`, `channel`,
`tbl`, `rid`) records which FTS rows each product owns, so a change deletes them and inserts the new
ones. A product has one row per locale it lists in. Search keeps no R2 or KV objects. It fills from
`ListingChange`s only, so products published before search existed enter on `reindex`. See
[Architecture](architecture.md#keyword-search).

The shard's `published` row's JSON (`aliases` column) now also keeps the product's `categories` as
published, which become `left` in the next `ListingChange`.

## Personal data

Where personal data is stored, and where it goes. Order Loop holds no data about anyone beyond what
a customer's orders, team and mail bring in; a deployment holds only one customer's.

| Where | What | Notes |
|---|---|---|
| `customers` | `name`, `email`; `stripe_customer_id`, `stripe_payment_method_id` | Indexed by `lower(email)` |
| `sellers` | `name`, `email` | Marketplace sellers |
| `orders` (D1) | `contact_email` (a guest buyer's email), `title`, `external_id` | `title` is free text and can name a person. Orders are kept (see [Retention](#retention)); `contact_email` and `title` are cleared by [erasure](#export-and-erasure), or by the retention sweep where `PERSONAL_DATA_RETENTION_DAYS` is set |
| OrderAgent state | The whole `Order`: `contact` (`email`, `name`, `phone`), `meta` (including `meta.shipTo`, the ship-to address, and any other key a caller sends), `title`, `documentText` (only until it is stored in R2, which `startOrder` does first), and the run's `vars`, node outputs and timeline | Durable Object storage, one per order, in the deployment's [jurisdiction](#data-residency). See [OrderAgent](order-agent.md#state) |
| R2 | `orders/<orderId>/inbound/po.txt` (the inbound document), `inbound/message.eml` (the raw email) | Served at `/docs/<key>` to signed-in users only. See [R2 documents](#r2-documents) |
| `inbound_emails` | `sender`, `subject` | Deleted after 180 days; the `.eml` in R2 is not |
| `messages` | `recipient`, `subject`, `body` | The `commerce.notify` outbox |
| `webhook_deliveries` | `payload`, the event JSON sent to a subscriber | Deleted after 90 days once delivered or failed |
| `users` | `email`, `name`, `password_hash`, `totp_secret` | The team |
| `sessions` | `ip`, `user_agent` | Deleted when expired |
| `audit_events` | `actor` (an email, `token:<name>` or `operator`), `target` (can be a person's email), `detail`, `ip` | Archived to R2 after `AUDIT_RETENTION_DAYS`, then deleted; the archive is kept unless `auditArchiveDays` is set |
| `auth_failures` | `key` (`email-ip:`, `ip:`, `email:` prefixes) | Dropped after a day |

`payments`, `shipments`, `invoices` and the ledgers hold ids, amounts and tracking numbers, not
names or addresses (`invoices.hosted_url` leads to the Stripe-hosted page).

### Data residency

A deployment's `jurisdiction` in the registry (`eu` or `fedramp`, [Operations](operations.md#the-registry)) places its D1 database and R2 bucket in that jurisdiction, and the engine's `DATA_JURISDICTION` does the same for its Durable Objects: `OrderAgent` (the order's live state, including the whole `Order`), `AssistantAgent` and `A2AAgent`. All access goes through `apps/engine/src/namespaces.ts`. The catalog Worker applies it the same way to all its objects (`CatalogShard`, `CatalogMeta`, `CatalogFeeds`, `ListingIndexer`, `SearchShard` and `CatalogPublisher`, all reached through `apps/catalog/src/config.ts`) and to its R2 bucket; its KV namespace of listing cards has no jurisdiction, so cards (names, prices and attributes of published products, no personal data) are outside it.

Each is fixed when the resource is created. Set the jurisdiction before the deployment's first order: with a different value the Durable Objects get different ids, and existing orders' live state is stranded (D1 and R2 can't move either). Local dev and tests leave it empty; workerd doesn't implement jurisdictions.

Not covered by this setting, so not controlled by OrderLoop's jurisdiction: Workflows instance state (memoized step results, which include node outputs), Workers AI inference, AI Gateway logs, and Workers logs. The Worker code itself runs at Cloudflare's edge nearest the request. Treat these as outside the jurisdiction when answering a residency question; see [To the model](#to-the-model) and [To AI Gateway and logs](#to-ai-gateway-and-logs).

### Export and erasure

A data subject request (`POST /api/v1/data-subjects/export` and `/erase`, admin; `handleDataSubjects` in
`apps/web/app/lib/api.server.ts`, `EngineRpc.exportDataSubject` and `eraseDataSubject`,
`apps/engine/src/subjects.ts`) is about one email address, matched as `lower(email)` (`subjectEmail`). The
subject is:

- the `customers` with that email;
- the `orders` with that `contact_email`, or whose `customer_id` is one of those customers;
- the orders an `inbound_emails` row from that `sender` started (`order_id`);
- the external carts (punchout sessions) whose `buyer_id` is the address.

Orders with `erased_at` set are no longer part of it. A `users` row with the address is only reported
(`teamMember`); it is never changed.

**Export** returns a JSON attachment: `customers` (without `stripe_payment_method_id`), up to 500 orders
(`truncated` when there were more) with `contact`, `lines` and `meta` read from each agent's state,
`messages` (to those orders or to the address), `inbound_emails` rows (without `r2_key`) and the
`documents` list (`key`, `kind`, `contentType`, `createdAt`), and `carts`: each of their external carts
(`CartAgent.subjectExport`) with its id, title, status, buyer, lines, order, and the messages and file
names, types and sizes they added.

**Erase** is refused with `409` `active_orders` (up to 20 ids) while any of the subject's un-erased orders
has a status outside `TERMINAL_ORDER_STATUSES`; the agent checks again (`erasePersonalData` returns
`null` for an order that is still running). An order that refuses in the middle of a call is skipped:
the rest of the batch is fully erased (agent state, R2, and the D1 rows below), and the call returns
`active_orders` naming the orders that refused. Otherwise it takes 100 orders a call (`done: false` means call again). `eraseOrders`
(`apps/engine/src/subjects.ts`) does the per-order work and is shared with the [retention sweep](#retention). For each order:

| Place | After |
|---|---|
| OrderAgent state | `eraseOrderState` (core): `contact`, `documentText` and `documentKey` removed; `meta` through `scrubPersonal` plus the subject's terms; `title`, line names, `vars`, node `summary`, `error` and `output`, timeline `message` and `data`, and `reason` have the terms replaced with `[erased]` and emails and phone numbers masked. The terms are the email, the customer account names, and the order's contact name, email and phone and `shipTo` name, each at least 3 characters, longest first |
| R2 | Objects under `orders/<id>/` deleted |
| `documents` | Rows for the order deleted |
| `webhook_deliveries` | Rows for the order deleted |
| `messages` | `recipient`, `subject` and `body` set to `[erased]` |
| `inbound_emails` | For rows with this `order_id`: `sender` set to `[erased]`, `subject` to `''`, `r2_key` to null |
| `orders` | `contact_email` null, `title` erased (an order no agent holds is erased in D1 with the terms), `erased_at` set |

Each call first erases the subject's external carts (`carts`, counted in `carts`) through
`CartAgent.eraseSubject`: an open cart is canceled, their messages and files are deleted, the terms
(with the buyer's id and name) are erased from everyone else's messages and the title, the return
form and start links are dropped, their sockets are closed, and the buyer becomes `[erased]`, which
clears `buyer_id`. The cart's lines, quote and order stay.

When no order is left (the last call, `done: true`): `inbound_emails` from that sender that never
started an order are erased the same way and their R2 `.eml` deleted, `messages` to the address are
erased, and each `customers` row becomes `name` `Erased customer`, `email`
`erased-<id>@erased.invalid` and `stripe_customer_id` and `stripe_payment_method_id` null. Lines, amounts,
`payments`, `shipments`, `invoices` and the ledgers are kept.

`audit_events` keep their events (append-only, own retention). Each request writes
`personal_data.exported` or `personal_data.erased` (filter group `personal_data`, "Personal data") with the
target `subject:` and the first 16 hex characters of the SHA-256 of the normalised email
(`fingerprintOf`), so the log does not hold the address.

Not reached: messages on staff carts or other buyers' carts that name the subject (until those carts'
retention clears them), and an external cart opened before `buyer_id` was recorded (migration `0050`)
until the retention sweep has indexed it (`indexCartBuyers`, 200 a run); the Workflow instance's params and step outputs, which Cloudflare Workflows retains; the
Stripe customer at Stripe (only the ids here are cleared); AI Gateway and Workers logs, which follow
their own retention; the R2 audit archives (`audit/…`, which expire only after the deployment's `auditArchiveDays`, if set); `sellers`; and `orders.external_id` and
`customer_id`, which stay on an erased order.

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

- **AI Gateway** records every model call's metadata. Only with request logs on (the registry's
  `aiGatewayLogs`, default `false`) does it keep the prompts and responses, up to 100,000 entries
  and until they're deleted. The engine sends the setting with every call (`collectLog`, from
  `AI_GATEWAY_LOGS`), so it holds whatever the gateway's own default is; logs kept before it was
  turned off stay until deleted in the dashboard.
  The assistant's calls never keep a payload even with logs on: they send
  `cf-aig-collect-log-payload: false`, so their entries keep the model, tokens, cost and a hashed
  principal but not the prompt or the tool results (customer names and order details) in them.
- **Workers logs** are on for the engine, web, catalog and catalog-edge Workers (`observability` in `wrangler.jsonc`, invocation logs
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
| `action_confirmations` | `expires_at` older than 1 day (`pruneConfirmations`; reported as `confirmations`) |
| `ai_usage` | `day` older than 90 days (`pruneUsage`; reported as `aiUsageDays`) |
| `ucp_idempotency` | `created_at` older than 48 hours (reported as `ucpIdempotency`) |
| `checkout_sessions` | no `order_id` and `expires_at` older than 30 days (reported as `abandonedCheckouts`) |
| Cart chat, files and buyers | A cart that ended (`submitted`, `returned` or `canceled`) over 90 days ago and not yet purged, up to 200 a run (`purgeEndedCarts`, `CartAgent.purge`; reported as `cartsPurged`): its chat, return form and start links deleted, its files under `carts/<id>/` deleted, its buyer `[erased]`, and `purged_at` set. Its lines, quote and order, and the `carts` row, are kept |
| (`carts.buyer_id`, backfill) | External carts with no `buyer_id`, from before migration `0050`: each cart's agent writes its row again (`indexCartBuyers`, up to 200 a run; reported as `cartBuyersIndexed`), so a data subject request finds them. A buyer erased before that (a `personal_data.erased` audit event for their address's `subjectTarget`) is erased from the cart as it is indexed. A row with no agent is marked `''`, which no request matches; a cart that can't answer waits for the next run without stopping the sweep |

The sweep also reseals stored secrets (`resealSecrets`, `apps/engine/src/data-key.ts`; reported as `secrets: { resealed, unreadable }`): values stored in plaintext before encryption are encrypted, and values under `DATA_KEY_PREVIOUS` move onto `DATA_KEY`, each written conditionally on the value read so a concurrent rotation isn't undone. A value no key opens is logged and counted in `unreadable`. See [Rotating the data key](operations.md#rotating-the-data-key).

Orders and everything in an order's record (payments, invoices, shipments, the stock and balance ledgers, flow versions) are kept.

`audit_events` is not pruned on write. The sweep moves events older than `AUDIT_RETENTION_DAYS` (default 400, at least 90; `auditRetentionDays` in core) to the `DOCS` R2 bucket (`archiveAudit`): one NDJSON object per batch of up to 1,000 events (one event a line, hashes included) at `audit/<yyyy-mm-dd>/<at>-<id>.ndjson`, at most 50,000 events a run, each batch deleted only after its object is written. Events from before the chain go first, by time; sealed events go in `seq` order and stop at the first one still within the retention, so what remains is an unbroken chain. The sweep reports the count as `auditArchived`.

The archive itself is kept unless the deployment's registry sets `auditArchiveDays`: `scripts/provision.sh` then replaces an R2 lifecycle rule named `audit-archive` on the prefix `audit/` that expires objects after that many days (see [Operations](operations.md#the-registry)). A bucket lock rule of the same name keeps each archived object from being deleted before that age (indefinitely when `auditArchiveDays` is unset), and another, `plugin-bundles`, keeps `plugins/` indefinitely ([Operations](operations.md#bucket-locks)).

### Personal data on finished orders

`PERSONAL_DATA_RETENTION_DAYS` is empty by default: personal data is kept. Where a deployment sets it (the registry's `personalDataRetentionDays`; `personalDataRetentionDays` in `packages/core/src/erasure.ts` raises anything below 30 to 30 and treats empty, zero or a non-integer as unset), the same sweep calls `expirePersonalData`. It picks up to 500 orders a run, oldest `updated_at` first, that have a status in `TERMINAL_ORDER_STATUSES`, no `erased_at`, and an `updated_at` older than that many days, and passes them to `eraseOrders`. Each order is erased as in an [erasure request](#export-and-erasure) (agent state, R2 `orders/<id>/`, `documents`, `webhook_deliveries`, `messages`, `inbound_emails`, and `orders.contact_email`, `title` and `erased_at`), except that the only terms erased are the order's own contact, and no `customers` row or unlinked intake mail is touched. An order whose agent refuses (running again) is skipped, logged as a `personal_data_retention_skipped` line, and tried again the next day; the rest of the batch goes ahead. Orders left over wait for the next day's run. The sweep reports the count as `personalDataErased`.
