# Configuration

Variables, secrets and bindings for the engine, web, catalog and catalog-edge Workers, and the local dev files.

Each Worker is configured in its `wrangler.jsonc`. After changing one, regenerate its binding
types: `pnpm --filter @orderloop/engine types`, `pnpm --filter @orderloop/web types` `pnpm --filter @orderloop/catalog types` or `pnpm --filter @orderloop/catalog-edge types`.

## Engine variables

Set in `vars` in `apps/engine/wrangler.jsonc`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI text model for every structured AI call (JSON mode) |
| `ASSISTANT_MODEL` | `@cf/moonshotai/kimi-k2.6` | Workers AI model for the [assistant](https://docs.orderloop.app/guides/assistant/); it needs multi-turn tool calling |
| `ASSESS_MODEL` | `@cf/cloudflare/clef` | Workers AI decision model for [Assess](https://docs.orderloop.app/guides/ai/#assess) and the assistant's `assess_order` |
| `AI_GATEWAY_ID` | `"orderloop"` | AI Gateway every model call goes through: logs, analytics and a rate limit of 120 requests a minute (sliding). `pnpm web:dev` overrides it to `""` in `apps/web/vite.config.ts`, so local calls go to Workers AI directly. Empty calls Workers AI directly. A rate-limited call falls back to the node's heuristic like any other failed call. Whether the gateway keeps the prompts and responses (request logs) is set when it is created: the registry's `aiGatewayLogs` ([Operations](operations.md#the-registry)) |
| `AI_PERSONAL_DATA` | `redact` | What the model sees of an order in the workflow AI nodes (Classify, Risk score, Agent router, Summarize, Assess) and the assistant's `assess_order`. `redact` sends the order's commercial facts only; any value but `send` redacts. `send` adds the contact, the unmasked title, `meta` and the customer's name and email. Never sent in either mode: `documentText`, payment ids and internal bookkeeping (`fxRate`, `taxRate`). The registry's `aiPersonalData` sets it per deployment. See [Personal data](data-model.md#personal-data) |
| `APP_ORIGIN` | `https://orderloop.app` | The app's own origin; an external cart's start link (`startUrl` from the plugin host API) is on it. `scripts/fleet.ts` sets `https://<domain>` per deployment; local dev uses `http://localhost:5173` |
| `OWN_HOSTS` | `orderloop.app,catalog.orderloop.app` | Hosts the deployment serves, comma-separated: an external cart's `returnUrl` may not be one of them, so its return never posts into the app with someone's session. `scripts/fleet.ts` sets the domain and catalog domain per deployment |
| `ASSISTANT_DAILY_TOKENS` | `1000000` | Model tokens one person's assistant conversations (in the app and A2A chat) may use per UTC day, counted in D1 `ai_usage`; `"0"` is no limit, anything not a whole number is the default (`assistantDailyTokens`). The registry's `assistantDailyTokens` sets it per deployment |
| `AI_MODE` | `live` | `live` calls the model; `mock` uses the deterministic heuristics only (tests, offline dev) |
| `TIME_SCALE` | `1` | Divides every wait and timeout. `"1"` is real time; `pnpm web:dev` overrides it to `"1440"` (a day becomes a minute) in `apps/web/vite.config.ts`, and the engine tests use `"1"` |
| `SIMULATE_FAILURES` | `""` | `"true"` honours `meta.simulate` (forced stockouts, declines, failed charges, invoice mismatches) from any caller; anything else drops it when an order starts (`apps/engine/src/orders.ts`). `apps/web/vite.config.ts` turns it on for local dev, `apps/engine/vitest.config.ts` for the engine tests, and `scripts/fleet.ts` for demo deployments. Leave it off in production: it lets an API caller fail a real order on purpose |
| `INTAKE_MAILBOXES` | `""` | Email intake: JSON object of mailbox local part to flow id. Empty uses `orders@` and `po@` → `tpl-b2b-order`, `purchasing@` → `tpl-purchase-request` |
| `INTAKE_REQUIRE_AUTH` | `true` | `"false"` accepts mail without a passing DMARC, DKIM or SPF result. Never in production: it lets anyone who forges a customer's From address start orders |
| `INTAKE_REPLY` | `true` | `"false"` turns off the acknowledgement reply to accepted email |
| `AUDIT_RETENTION_DAYS` | `400` | Days audit events are kept before the daily sweep archives them to R2 and deletes them. Below 90 is raised to 90 (`auditRetentionDays`); the database refuses to delete younger events. The registry's `auditRetentionDays` sets it per deployment |
| `PERSONAL_DATA_RETENTION_DAYS` | empty | Days after an order finishes (`updated_at` of a terminal order) that the daily sweep erases its buyer's personal data, up to 500 orders a run; the commercial record stays. Empty keeps it; below 30 is raised to 30 (`personalDataRetentionDays`). The registry's `personalDataRetentionDays` sets it per deployment. See [Retention](data-model.md#personal-data-on-finished-orders) |
| `DATA_JURISDICTION` | empty | Jurisdiction of the engine's Durable Objects (`OrderAgent`, `AssistantAgent`, `A2AAgent`): `eu` or `fedramp`, or empty for no jurisdiction; any other value throws on first use (`apps/engine/src/namespaces.ts`). The registry's `jurisdiction` sets it per deployment (`scripts/fleet.ts`). Local dev and tests leave it empty, since workerd has no jurisdictions. Set it before a deployment's first order: a different value gives different object ids, so existing orders' live state is unreachable. See [Data residency](data-model.md#data-residency) |
| `PAYMENTS_MODE` | `mock` | The payment gateway for new payments (`apps/engine/src/payments.ts`). `mock` records payments in D1 only, and `meta.simulate` drives declines and failed charges. `stripe` authorizes, captures, charges, voids and refunds through Stripe with `STRIPE_SECRET_KEY`, and `commerce.invoice` with provider `stripe` issues Stripe invoices (`apps/engine/src/billing.ts`; in `mock` it records them only); without the key every payment step fails with a `NonRetryableError`. Any other value fails payment steps too. Voids, captures and refunds follow each payment row's own `provider`, so rows made before a switch are settled where they were made. Set per deployment by the registry's `payments`. See [Payments](https://docs.orderloop.app/guides/payments/) |
| `STRIPE_PUBLISHABLE_KEY` | `""` | Stripe publishable key (`pk_…`) that a [UCP](https://docs.orderloop.app/reference/ucp/) platform tokenizes the buyer's card with. It is published in the `app.orderloop.stripe` payment handler's `config` (`paymentHandlers`, `apps/engine/src/ucp/config.ts`). With `PAYMENTS_MODE` `stripe` and no key, agentic checkout offers no payment handler; in `mock` it offers the test handler `app.orderloop.test` instead and ignores the key. Set per deployment by the registry's `stripePublishableKey` |

## Catalog variables

The catalog Worker has five variables and no secrets (`apps/catalog/wrangler.jsonc`); the catalog-edge Worker has neither variables nor secrets (`apps/catalog-edge/wrangler.jsonc`):

| Variable | Default | Meaning |
|---|---|---|
| `DATA_JURISDICTION` | empty | Jurisdiction of the catalog's Durable Objects (`CatalogShard`, `CatalogMeta`, `CatalogFeeds`, `ListingIndexer`, `SearchShard`, `CatalogPublisher`): `eu` or `fedramp`, or empty for none; any other value throws on first use (`apps/catalog/src/config.ts`). The registry's `jurisdiction` sets it per deployment, and the catalog's R2 bucket takes the same one (`scripts/fleet.ts`). Local dev and tests leave it empty. Set it before the first product: a different value gives different object ids, so existing products are unreachable. See [Data residency](data-model.md#data-residency) |
| `FEED_CHUNK` | `25000` | Products one `FeedImport` split step reads before handing off to the next (a string; `25000` when unset or not a number, `FEED_CHUNK` in core). Lower it only in tests, where `apps/catalog/vitest.config.ts` sets `300` so a small feed spans several steps |
| `ORDERS_CHANNEL` | `web` | The channel code whose prices feed Order Loop's `products` table (`apps/catalog/src/orders.ts`, `publishKeys`): each active variant priced there in `BASE_CURRENCY` (`USD`) is upserted with its name and price. A channel in another currency writes nothing. Changing it applies to products as they next publish (or on `reindex`); rows already written stay. See [Order Loop's products](architecture.md#order-loops-products) |
| `LISTING_DELAY_MS` | `0` | The least time before a listing index segment builds after a change (`ListingIndexer.apply`, `apps/catalog/src/listings.ts`), on top of the debounce (15 s, or a second per 20,000 members of the last build, at most 5 minutes). `0` builds a new category's index at once. The tests set it to an hour and run each build themselves (`runDurableObjectAlarm`), so no build is left running when a test file ends |
| `PUBLISH_FANOUT` | `32` | Publishers (`CatalogPublisher`) each shard spreads a pass's storage writes over (`apps/catalog/src/publisher.ts`, `publishKeys`). One invocation has only six storage calls in flight, so this multiplies how fast a shard publishes. A string; `32` when unset, `0` or not a number, and a negative value becomes 1. `1` makes the shard do its writes itself. Raising it creates more publisher objects (`pub-<shard>-<n>`); lowering it strands none, since publishers keep no state |

## Compatibility flags

`apps/engine/wrangler.jsonc` sets `nodejs_compat` and `global_fetch_strictly_public`. The second
makes the engine's outbound `fetch` (outbound webhooks, [A2A push
notifications](https://docs.orderloop.app/reference/a2a/#push-notifications) and live shipping carriers' quote
requests, whose URLs callers or flow authors supply) reach public addresses only, not private or loopback ones.

## Engine secrets

Set with `pnpm --filter @orderloop/engine exec wrangler secret put <NAME>`.

| Secret | Meaning |
|---|---|
| `PRINCIPAL_KEY` | Required. The key the engine checks the signature on the principal header with, the same value as the web Worker's. The engine refuses `/mcp`, `/a2a`, `/ucp/*` (whose header is a separate `u1` envelope, see [UCP](architecture.md#ucp-agentic-checkout)) and the agent sockets without a header signed with it (and logs that it is unset). Local dev needs nothing: `apps/web/vite.config.ts` gives the engine `DEV_PRINCIPAL_KEY` (from core). See [Rotating the principal key](operations.md#rotating-the-principal-key) |
| `PRINCIPAL_KEY_PREVIOUS` | Optional, only during a rotation: the old key, also accepted for verification. Remove it once the new key is deployed |
| `DATA_KEY` | Required. Encrypts the secrets the deployment stores (AES-256-GCM, key derived with HKDF-SHA256; `encryptSecret` in core): in this Worker the A2A push configs' `token` and `auth_credentials` and the queued notifications' `headers` in each `A2AAgent`'s SQLite, and the webhook and integration secrets it reads to sign deliveries. The same value as the web Worker's. Local dev needs nothing: `apps/web/vite.config.ts` gives the engine `DEV_DATA_KEY` (from core); the engine tests bind `DATA_KEY: 'test-data-key'`. See [Rotating the data key](operations.md#rotating-the-data-key) |
| `DATA_KEY_PREVIOUS` | Optional, only during a rotation: the old key, still read, and the daily sweep moves what it sealed onto `DATA_KEY` (`resealSecrets`, `apps/engine/src/data-key.ts`). Remove it once the sweep reports no unreadable secrets |
| `INTAKE_ALLOWLIST` | Extra senders allowed to start orders by email: addresses or `@domains`, comma-separated. Customers' own addresses and company domains are always allowed. See [Email intake](https://docs.orderloop.app/guides/email-intake/#who-may-send) |
| `SHIPPING_CARRIER_AUTH` | Credentials for the live carriers in a [Shipping rate](https://docs.orderloop.app/reference/nodes/#commerce.shipping_rate) node's `liveCarriers`: a JSON object from carrier `id` to the `Authorization` header value sent with its quote request, e.g. `{"acme":"Bearer …"}`. A carrier with no entry is called without one; unparseable JSON counts as empty. See [Shipping rates](https://docs.orderloop.app/guides/fulfillment/#shipping-rates) |
| `UCP_SIGNING_KEY` | Optional. A private P-256 JWK (`kty` `EC`, `crv` `P-256`, `d`) with a `kid`, as JSON: the key that signs [UCP](https://docs.orderloop.app/reference/ucp/#orders-and-events) order events (RFC 9421, ES256). Its public half is published in `keys` at `/.well-known/ucp`. Without one (or if it doesn't parse, which is logged) the profile publishes no keys and no order events are sent, since UCP requires them signed. Generate one with `crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])` and `exportKey('jwk')`, add a `kid`, and add it to the deployment's GitHub environment secrets; the deploy passes it to the engine. Tests use a throwaway key in `apps/engine/vitest.config.ts` |
| `STRIPE_SECRET_KEY` | Stripe secret or restricted key (`sk_…`, `rk_…`), required when `PAYMENTS_MODE` is `stripe`. A restricted key needs write access to PaymentIntents, Refunds and Customers, and to Invoices and Invoice Items when a flow issues invoices through Stripe. With a test key (`sk_test_`/`rk_test_`), an order with no payment method pays with `pm_card_visa`, and `meta.simulate` `payment_decline` or `charge_fail` uses `pm_card_visa_chargeDeclined`; a live key never substitutes a card. Every request pins `Stripe-Version` (`STRIPE_API_VERSION` in `apps/engine/src/stripe.ts`). Deploys pass it from the deployment's GitHub environment (`SECRETS` in `scripts/fleet.ts`) |

## Web variables

Set in `vars` in `apps/web/wrangler.jsonc`.

| Variable | Default | Meaning |
|---|---|---|
| `ORDER_ROUTES` | `""` | Inbound orders: JSON object from `model:channel` or `model:*` to a flow id, overriding the built-in routes (`DEFAULT_ORDER_ROUTES` in `packages/core/src/inbound.ts`: `b2c:pos` and `d2c:pos` → `tpl-pos-sale`) key by key. Keys are lowercase letters, digits and underscores (`*` allowed after the colon); entries with another key or an empty flow id are dropped, as is a value that isn't a JSON object. A route that isn't set starts the model's default flow. See [Inbound orders](https://docs.orderloop.app/guides/inbound-orders/#routing) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | `""` | Single sign-on with an OpenID Connect provider (`app/lib/sso.server.ts`): the issuer (https; its `/.well-known/openid-configuration` is fetched, cached an hour, and must name the same issuer) and this deployment's client id. `scripts/fleet.ts` sets both from the registry's `sso` ([operations](operations.md#the-registry)). With the `OIDC_CLIENT_SECRET` secret all three put **Sign in with single sign-on** on the sign-in page; with any empty, `/login/sso` redirects to `/login`. The redirect URI to register at the provider is `https://<domain>/login/sso/callback`. Admins choose the rest on the Team page: the workspace setting `sso` ([data model](data-model.md#people-and-tokens)) |
| `DEMO_MODE` | `""` | `"true"` only on a demo deployment, where `scripts/fleet.ts` sets it (see [The demo](operations.md#the-demo)). The sign-in page offers one-click sign-in as the shared `demo@orderloop.app` operator, who never owes two-factor setup; changes on Team and Account, `/oauth/authorize`, integrations and webhook subscriptions answer `403` (`apps/web/app/lib/demo.server.ts`); the flow templates are checked on every load, since the nightly reset removes them |
| `EDI_PARTNERS` | `""` | EDI 850s: JSON object from a trading partner's ISA sender id to the customer id it orders for, e.g. `{ "NORTHWIND": "cus_northwind" }`. A sender not listed is refused with `403`. See [Channel adapters](https://docs.orderloop.app/guides/channel-adapters/#edi-x12-850) |

## Web secrets

Set with `pnpm --filter @orderloop/web exec wrangler secret put <NAME>`, or in `apps/web/.dev.vars`
for local dev (copy `apps/web/.dev.vars.example`).

| Secret | Meaning |
|---|---|
| `PRINCIPAL_KEY` | Required. Signs the principal header on every request the web Worker forwards to the engine (order and assistant sockets, `/mcp`, `/a2a`, `/ucp/*`): HMAC-SHA256 over the principal, the path and a 60-second expiry (`signPrincipal`, `apps/web/app/lib/principal.server.ts`). Must equal the engine's. In local dev it falls back to `DEV_PRINCIPAL_KEY`; elsewhere an unset key fails the request. `scripts/provision.sh` generates it (`openssl rand -hex 32`); a deploy fails before migrating when the GitHub environment lacks it |
| `DATA_KEY` | Required. Encrypts the secrets the web app stores in D1: `users.totp_secret`, `integrations.secret` and `previous_secret`, `webhook_subscriptions.secret` and `previous_secret` (`sealSecret` and `openSecret`, `apps/web/app/lib/data-key.server.ts`). Must equal the engine's. In local dev it falls back to `DEV_DATA_KEY`; elsewhere an unset key throws. `scripts/provision.sh` generates it (`openssl rand -hex 32`) beside `PRINCIPAL_KEY`; a deploy fails before migrating when the GitHub environment lacks it. Never lose it: see [Rotating the data key](operations.md#rotating-the-data-key) |
| `DATA_KEY_PREVIOUS` | Optional, only during a rotation: the old key, still read. Remove it once the engine's sweep has moved every secret onto `DATA_KEY` |
| `SETUP_TOKEN` | The deployment's one-time setup code: on `/setup` it creates an admin account, once (its SHA-256 is recorded in `workspace_settings` as `setup_code_used`). `scripts/provision.sh` generates it into `.secrets/<id>/setup-code` and `scripts/setup-code.sh` replaces it to recover admin access. Unset, `/setup` creates nobody. See [Sign-in setup and open mode](deploy.md#sign-in-setup-and-open-mode) |
| `OIDC_CLIENT_SECRET` | The identity provider's client secret for single sign-on, from the deployment's GitHub environment (`deploy.yml` passes it; `fleet.ts` lists it among the web Worker's secrets). The token endpoint is called with `client_secret_basic`, or the secret in the body when the provider's metadata lists methods without it. Unset: no single sign-on |
| `STRIPE_WEBHOOK_SECRET` | The signing secret (`whsec_…`) of the Stripe webhook endpoint that points at `POST /api/v1/webhooks/stripe`; the route verifies `Stripe-Signature` with it and answers `503` while it is unset. For local dev it is the secret `stripe listen` prints. Deploys pass it from the deployment's GitHub environment (`SECRETS.web` in `scripts/fleet.ts`). See [Stripe webhook](deploy.md#stripe-webhook) |
| `SHOPIFY_WEBHOOK_SECRET` | The Shopify app's client secret; enables `POST /api/v1/channels/shopify/orders`, which verifies `X-Shopify-Hmac-Sha256` with it. Unset answers `503`. See [Channel adapters](https://docs.orderloop.app/guides/channel-adapters/#shopify) |

Outbound webhook subscriptions and inbound integrations (the keys that sign
`POST /api/v1/webhooks/events` and `/orders`) each have their own secret, generated when they are
created through the API and stored in D1; they are not configuration.

## Bindings

| Binding | Worker | Resource |
|---|---|---|
| `DB` | engine, web, catalog | D1 database `orderloop`; migrations in `packages/db/migrations`. The catalog only writes `products.name`, `price` and `catalog_at`; a customer's database is rendered into the catalog's config at deploy (`renderCatalog`, which refuses a deployment without `d1Id`) |
| `DOCS` | engine, web | R2 bucket `orderloop-docs`: invoices, POs and inbound documents |
| `ORDER_AGENT` | engine | Durable Object `OrderAgent` (SQLite-backed), one per order |
| `ASSISTANT_AGENT` | engine | Durable Object `AssistantAgent` (SQLite-backed, migration `v2`), one per person |
| `A2A_AGENT` | engine | Durable Object `A2AAgent` (SQLite-backed, migration `v3`), one per [A2A](https://docs.orderloop.app/reference/a2a/) caller |
| `PLUGIN_STORAGE` | engine | Durable Object `PluginStorage` (SQLite-backed, migration `v4`), one per sandboxed plugin id: the plugin's own database (`PluginDb` in `apps/engine/src/plugin-host.ts`), with the bundle's migrations applied once each. Unused until a deployment installs a plugin with `runtime` `sandboxed` |
| `LOADER` | engine | Worker Loader (`worker_loaders` in `wrangler.jsonc`; open beta, Workers Paid): loads a sandboxed plugin's bundle as a Dynamic Worker, with `PluginEgress` as its `globalOutbound`, `PluginTail` as its tail and `PluginDb` (over `PluginStorage`) and `PluginSecrets` as its env. Unused until a plugin is sandboxed. See [Plugins](plugins.md#runtimes) |
| `ORDER_LOOP` | engine | Workflow `orderloop-order` (class `OrderLoop`), up to 10,000 steps per instance |
| `REPLENISH` | engine | Workflow `orderloop-replenish` (class `Replenish`), scheduled `0 6 * * *` |
| Cron trigger | engine | `triggers.crons` `30 3 * * *`: `scheduled()` runs the daily [retention sweep](data-model.md#retention) |
| `AI` | engine | Workers AI |
| `CATALOG` | web | Service binding to `orderloop-catalog`, entrypoint `CatalogApi`: `/api/v1/catalog` ([Architecture](architecture.md#catalog-admin-api)). A customer's is `orderloop-catalog-<id>`, rendered at deploy (`renderWeb`) |
| `SHARD` | catalog | Durable Object `CatalogShard` (SQLite-backed, migration `v1`), 64 shards named `shard-<n>` |
| `META` | catalog | Durable Object `CatalogMeta` (SQLite-backed, migration `v1`), one, named `meta` |
| `FEEDS` | catalog | Durable Object `CatalogFeeds` (SQLite-backed, migration `v2`), one, named `feeds` |
| `FEED_IMPORT` | catalog | Workflow `orderloop-catalog-feed` (class `FeedImport`), up to 10,000 steps per instance |
| `LISTINGS` | catalog | Durable Object `ListingIndexer` (SQLite-backed, migration `v3`), one per channel, category and listing segment, named `<channel>:<category>:<segment>` |
| `SEARCH` | catalog | Durable Object `SearchShard` (SQLite-backed, migration `v4`), 16 shards named `search-<n>` |
| `PUBLISHERS` | catalog | Durable Object `CatalogPublisher` (SQLite-backed, migration `v5`), `PUBLISH_FANOUT` (32) per shard named `pub-<shard>-<n>`: does the storage writes of a shard's publishes |
| `FEED_PARTS` | catalog | Queue `orderloop-catalog-feed-parts`, produced and consumed by the catalog Worker (batches of 10, 1 second, `max_retries` 4, dead-letter queue `orderloop-catalog-feed-parts-dlq`) |
| `CHANGES` | catalog | Queue `orderloop-catalog-changes`: the shards' alarms send each publish's listing changes, packed up to 64 KB a message, and the catalog Worker consumes them (`max_batch_size` 100 messages, `max_batch_timeout` 2 seconds, `max_retries` 10, dead-letter queue `orderloop-catalog-changes-dlq`) |
| `PUBLISHED` | catalog | R2 bucket `orderloop-catalog`: product documents, alias pointers, category trees, listing indexes (`idx/`) and feed files (`feeds/`). Strongly consistent, so a purge is never undone by a stale read |
| `PURGE` | catalog | Queue producer for `orderloop-catalog-purge`: the alarm sends the cache tags (`PurgeMessage`) of urgent products after publishing them |
| `CARDS` | catalog | KV namespace of listing cards and `u:f1:<key>` uid entries. `wrangler.jsonc` holds `orderloop`'s id; a customer's is the registry's `catalogKvId`, rendered at deploy |
| `PUBLISHED` | catalog-edge | The same R2 bucket, `orderloop-catalog`, read |
| `CARDS` | catalog-edge | The same KV namespace, read |
| `CATALOG` | catalog-edge | Service binding to `orderloop-catalog`, entrypoint `SearchApi` (a customer's is `orderloop-catalog-<id>`, rendered at deploy) |
| `ANALYTICS` | catalog-edge | Analytics Engine dataset `orderloop_catalog_edge` (a customer's is `orderloop_catalog_edge_<id>`) |
| Queue consumer | catalog-edge | `orderloop-catalog-purge` (`max_batch_size` 100, `max_batch_timeout` 12 seconds, `max_concurrency` 1, `max_retries` 10, dead-letter queue `orderloop-catalog-purge-dlq`) |
| Workers Caching | catalog-edge | `cache: { enabled: true, cross_version_cache: true }`, and `exports`: the default (gateway) entrypoint has the cache off, `Delivery` has it on |
| `ENGINE` | web | Service binding to `orderloop-engine`, entrypoint `EngineApi` |
| `PLUGIN_<ID>` | engine, web | Service binding to `orderloop-plugin-<id>` for each plugin in the registry's `plugins` whose `runtime` is `worker` (the default; a `sandboxed` one has no Worker or binding; `pluginServices` in `scripts/fleet.ts`; none in the base `wrangler.jsonc` files). A plugin's own Worker has a `DB` D1 binding and, as secrets, `PLUGIN_KEY` and, during a rotation, `PLUGIN_KEY_PREVIOUS` (`fleet.ts secrets plugin <out> <plugin>`), to verify the principal the web Worker signs for that plugin. See [Plugins](plugins.md) |
| `PLUGIN_KEY`, `PLUGIN_KEY_PREVIOUS` | each plugin | Secrets, one pair per plugin Worker. `PLUGIN_KEY` is the plugin's own page-signing key: the hex HMAC-SHA256 of `PRINCIPAL_KEY` over `orderloop-plugin:<id>` (`pluginKey` in `packages/core/src/plugins.ts`, mirrored in `scripts/fleet.ts`), and `PLUGIN_KEY_PREVIOUS` the same from `PRINCIPAL_KEY_PREVIOUS`, written only when that is set. The web Worker signs a plugin's page requests with it; the engine and other plugins refuse it, and a plugin never holds `PRINCIPAL_KEY`. CI writes one secrets file per plugin. In local dev `apps/web/vite.config.ts` derives it from `DEV_PRINCIPAL_KEY` |
| `<NAME>` (each declared secret) | each plugin | The secrets a plugin's manifest declares in `secrets` (an outside service's API key, say), set in the deployment's GitHub environment as `PLUGIN_<ID>_<NAME>` (`pluginSecretVar` in `packages/core/src/plugins.ts`) and written to that plugin's secrets file under `<NAME>` (`pluginOwnSecrets` in `scripts/fleet.ts`). Only the plugin with that prefix gets it. A required one that is missing fails the plugin's manifest, so deep health fails. In local dev, `plugins/<id>/.dev.vars`. See [Plugins](plugins.md#secrets) |
| `PLUGIN_SECRET_<ID>__<NAME>` | engine | Secrets Store binding (`secrets_store_secrets`) for a sandboxed plugin's secret, only on a deployment with a `secretsStore` and the name listed in `plugins.<id>.secrets` (`storeBinding` in `scripts/fleet.ts`; `<ID>` as in `PLUGIN_<ID>`, so `fixture-carrier`'s `API_KEY` is `PLUGIN_SECRET_FIXTURE_CARRIER__API_KEY`). It points at the store's secret `PLUGIN_<ID>_<NAME>`, read on each call, so rotating it in the store needs no deploy. Ids have no `--`, so the `__` is unambiguous. A Worker plugin's own Worker binds the same store secret under `<NAME>` (`renderPlugin`) |
| `PLUGIN_BUNDLES` | engine | Var, JSON `{"<plugin id>":"<sha>"}`: the sandboxed plugins and the sha256 of the bundle each must hash to. CI's **Publish sandboxed plugins** step puts each bundle in `DOCS` as `plugins/<id>/<sha>.json` and writes the pins into the rendered engine config; the engine refuses a bundle that doesn't match. Absent when no plugin is sandboxed; invalid JSON loads none (and logs). A Worker rollback restores the previous pins |
| `PLUGIN_SECRETS` | engine | Secret, JSON `{"<plugin id>":{"<NAME>":"…"}}`, on a deployment without a `secretsStore`: written by `fleet.ts secrets sandboxed` from the environment's `PLUGIN_<ID>_<NAME>` secrets into the engine's secrets file. Each sandboxed plugin gets only its own entry; `PluginSecrets.get` returns a value only for a secret marked `expose` |
| `PLUGIN_DEV_BUNDLES` | engine | Dev only, JSON `{"<plugin id>":"<bundle JSON>"}`: bundles `pnpm web:dev` builds at startup for `ORDERLOOP_DEV_PLUGINS=<id>:sandboxed` (`apps/web/vite.config.ts`), because dev's `DOCS` bucket doesn't hold them. Checked against `PLUGIN_BUNDLES` like any other; never set in a deployment |
| `PLUGIN_GRANTS` | engine | Var, JSON `{"<plugin id>":{"personalData":"send"}}`, rendered by `renderEngine` from the registry's `plugins.<id>.personalData` (absent when no plugin has one). A manifest with `personalData: "send"` is refused unless its id is here; invalid JSON grants nothing (and logs). See [Plugins](plugins.md#installing) |
| `PLUGIN_PUBLISHERS` | engine | Var, JSON `{"<name>":"<Ed25519 public key, base64url>"}`, rendered by `renderEngine` from the registry's `pluginInstalls.publishers` (absent without it, which turns runtime installs off). An admin can install a sandboxed plugin from the Plugins page only if one of these signed it. In local dev, `ORDERLOOP_DEV_PUBLISHER=<name>:<public key>` sets it (`apps/web/vite.config.ts`). See [Plugins](plugins.md#installing-at-runtime) |
| `OAUTH_REGISTER_LIMIT`, `OAUTH_TOKEN_LIMIT` | web | Workers rate-limit bindings (`ratelimits` in `wrangler.jsonc`): 10 requests a minute to `/oauth/register` and 60 to `/oauth/token`, per address; over the limit answers `429 slow_down` |
| `API_LIMIT`, `AGENT_LIMIT`, `WEBHOOK_LIMIT` | web | Per-caller budgets (`app/lib/rate-limit.ts`): 600 requests a minute per principal on `/api/v1` (after authentication), 300 per principal on each of `/mcp` and `/a2a` (keyed `<path>:<principal id>`) and 300 per registered UCP platform on `/ucp` (`/ucp:<platform id>`, `AGENT_LIMIT`), and 1,200 per integration on the signed webhooks (after the signature verifies, so a forged request can't spend a sender's budget) or per shop on Shopify's. Over the limit answers `429` with `Retry-After: 60`. A deployment's `limits` in the registry replace these numbers ([Operations](operations.md#the-registry)). Counted per Cloudflare location, so they stop a runaway client rather than meter it exactly. Without the binding (unit tests) nothing is limited |
| `OAUTH_KV` | web | KV namespace for [MCP](https://docs.orderloop.app/reference/mcp/) and [A2A](https://docs.orderloop.app/reference/a2a/) OAuth clients, grants and tokens (tokens hashed, grant data encrypted). `wrangler.jsonc` gives no id; the namespace is provisioned on deploy |

The web Worker's compatibility flags are `nodejs_compat` and `global_fetch_strictly_public`. The
second keeps fetches of an MCP client's Client ID Metadata Document (an https `client_id`) to the
public internet.

## Routes and hostnames

The web Worker serves `orderloop.app` as a custom domain; change `routes` in
`apps/web/wrangler.jsonc` for your own. The engine has no routes, no `workers.dev` URL and no preview
URLs: only the web app's service binding reaches it, plus Email Routing rules that send mail to it
(see [Email intake](deploy.md#email-intake)). The docs Worker (`apps/docs/wrangler.jsonc`)
serves `docs.orderloop.app`, and likewise sets `workers_dev` and `preview_urls` to `false`.

The catalog Worker has no routes, no `workers_dev` URL and no preview URLs, and only catalog-edge
(`SearchApi`) and the web app (`CatalogApi`) bind to it; it answers `GET /health` with `{ ok: true }` and `404` otherwise. CI doesn't smoke-test it.

The catalog-edge Worker serves `catalog.orderloop.app` as a custom domain (a customer's is the
registry's `catalogDomain`, default `catalog.<domain>`, rendered at deploy), with `workers_dev` and
`preview_urls` off. It answers `GET /health` with `{ ok: true }`, and CI smoke-tests it. Its
compatibility flags are `nodejs_compat` and `global_fetch_strictly_public`; `observability` is on
with `head_sampling_rate` 0.05 (logs from 5% of requests; every request is still counted in Analytics
Engine) and source maps are uploaded.

Both app Workers answer `GET /health` with `{ ok: true, service }`. The web app's
`GET /health/deep` also checks D1, R2 and the engine (see
[Request routing](architecture.md#request-routing)). The web app sets `workers_dev` and
`preview_urls` to `false` too, so `orderloop.app` is its only address and the zone's rules apply to
every request.

## Runtime limits and observability

The catalog Worker turns `observability` on at the default sampling and sets `limits.cpu_ms` to 300,000, since a feed step parses and validates up to 25,000 products. Both app Workers log and trace every request (`observability` with `head_sampling_rate` 1, invocation logs
and traces on); lower the rate once traffic makes the volume or cost matter. `limits.cpu_ms` stops a
runaway invocation: 5,000 for the web app, 10,000 for the engine (the platform default is 30,000). I/O
waits, such as model calls, don't count against it. Both app Workers set `placement.mode` to `smart`: the web
app runs near D1 and the engine rather than near the visitor, and the engine runs near D1 rather
than near the web app (keep it only while Observability shows lower D1 latency).

Each audit write logs one JSON line, `{"type":"audit_event", …}` with the sealed row, to Workers Logs, where Logpush can carry it to a SIEM; a failed write logs `{"type":"audit_write_failed","action":…,"error":…}` instead, to alert on. Writing still never throws.
