# Configuration

Variables, secrets and bindings for the engine and web Workers, and the local dev files.

Both Workers are configured in their `wrangler.jsonc`. After changing one, regenerate its binding
types: `pnpm --filter @orderloop/engine types` or `pnpm --filter @orderloop/web types`.

## Engine variables

Set in `vars` in `apps/engine/wrangler.jsonc`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI text model for every structured AI call (JSON mode) |
| `ASSISTANT_MODEL` | `@cf/moonshotai/kimi-k2.6` | Workers AI model for the [assistant](https://docs.orderloop.app/guides/assistant/); it needs multi-turn tool calling |
| `ASSESS_MODEL` | `@cf/cloudflare/clef` | Workers AI decision model for [Assess](https://docs.orderloop.app/guides/ai/#assess) and the assistant's `assess_order` |
| `AI_GATEWAY_ID` | `"orderloop"` | AI Gateway every model call goes through: logs, analytics and a rate limit of 120 requests a minute (sliding). `pnpm web:dev` overrides it to `""` in `apps/web/vite.config.ts`, so local calls go to Workers AI directly. Empty calls Workers AI directly. A rate-limited call falls back to the node's heuristic like any other failed call. Whether the gateway keeps the prompts and responses (request logs) is set when it is created: the registry's `aiGatewayLogs` ([Operations](operations.md#the-registry)) |
| `AI_PERSONAL_DATA` | `redact` | What the model sees of an order in the workflow AI nodes (Classify, Risk score, Agent router, Summarize, Assess) and the assistant's `assess_order`. `redact` sends the order's commercial facts only; any value but `send` redacts. `send` adds the contact, the unmasked title, `meta` and the customer's name and email. Never sent in either mode: `documentText`, payment ids and internal bookkeeping (`fxRate`, `taxRate`). The registry's `aiPersonalData` sets it per deployment. See [Personal data](data-model.md#personal-data) |
| `AI_MODE` | `live` | `live` calls the model; `mock` uses the deterministic heuristics only (tests, offline dev) |
| `TIME_SCALE` | `1` | Divides every wait and timeout. `"1"` is real time; `pnpm web:dev` overrides it to `"1440"` (a day becomes a minute) in `apps/web/vite.config.ts`, and the engine tests use `"1"` |
| `INTAKE_MAILBOXES` | `""` | Email intake: JSON object of mailbox local part to flow id. Empty uses `orders@` and `po@` → `tpl-b2b-order`, `purchasing@` → `tpl-purchase-request` |
| `INTAKE_REQUIRE_AUTH` | `true` | `"false"` accepts mail without a passing DMARC, DKIM or SPF result. Never in production: it lets anyone who forges a customer's From address start orders |
| `INTAKE_REPLY` | `true` | `"false"` turns off the acknowledgement reply to accepted email |
| `AUDIT_RETENTION_DAYS` | `400` | Days audit events are kept before the daily sweep archives them to R2 and deletes them. Below 90 is raised to 90 (`auditRetentionDays`); the database refuses to delete younger events. The registry's `auditRetentionDays` sets it per deployment |
| `PERSONAL_DATA_RETENTION_DAYS` | empty | Days after an order finishes (`updated_at` of a terminal order) that the daily sweep erases its buyer's personal data, up to 500 orders a run; the commercial record stays. Empty keeps it; below 30 is raised to 30 (`personalDataRetentionDays`). The registry's `personalDataRetentionDays` sets it per deployment. See [Retention](data-model.md#personal-data-on-finished-orders) |
| `PAYMENTS_MODE` | `mock` | The payment gateway for new payments (`apps/engine/src/payments.ts`). `mock` records payments in D1 only, and `meta.simulate` drives declines and failed charges. `stripe` authorizes, captures, charges, voids and refunds through Stripe with `STRIPE_SECRET_KEY`, and `commerce.invoice` with provider `stripe` issues Stripe invoices (`apps/engine/src/billing.ts`; in `mock` it records them only); without the key every payment step fails with a `NonRetryableError`. Any other value fails payment steps too. Voids, captures and refunds follow each payment row's own `provider`, so rows made before a switch are settled where they were made. See [Payments](https://docs.orderloop.app/guides/payments/) |

## Compatibility flags

`apps/engine/wrangler.jsonc` sets `nodejs_compat` and `global_fetch_strictly_public`. The second
makes the engine's outbound `fetch` (outbound webhooks, [A2A push
notifications](https://docs.orderloop.app/reference/a2a/#push-notifications) and live shipping carriers' quote
requests, whose URLs callers or flow authors supply) reach public addresses only, not private or loopback ones.

## Engine secrets

Set with `pnpm --filter @orderloop/engine exec wrangler secret put <NAME>`.

| Secret | Meaning |
|---|---|
| `INTAKE_ALLOWLIST` | Extra senders allowed to start orders by email: addresses or `@domains`, comma-separated. Customers' own addresses and company domains are always allowed. See [Email intake](https://docs.orderloop.app/guides/email-intake/#who-may-send) |
| `SHIPPING_CARRIER_AUTH` | Credentials for the live carriers in a [Shipping rate](https://docs.orderloop.app/reference/nodes/#commerce.shipping_rate) node's `liveCarriers`: a JSON object from carrier `id` to the `Authorization` header value sent with its quote request, e.g. `{"acme":"Bearer …"}`. A carrier with no entry is called without one; unparseable JSON counts as empty. See [Shipping rates](https://docs.orderloop.app/guides/fulfillment/#shipping-rates) |
| `STRIPE_SECRET_KEY` | Stripe secret or restricted key (`sk_…`, `rk_…`), required when `PAYMENTS_MODE` is `stripe`. A restricted key needs write access to PaymentIntents, Refunds and Customers, and to Invoices and Invoice Items when a flow issues invoices through Stripe. With a test key (`sk_test_`/`rk_test_`), an order with no payment method pays with `pm_card_visa`, and `meta.simulate` `payment_decline` or `charge_fail` uses `pm_card_visa_chargeDeclined`; a live key never substitutes a card. Every request pins `Stripe-Version` (`STRIPE_API_VERSION` in `apps/engine/src/stripe.ts`). Deploys pass it from the deployment's GitHub environment (`SECRETS` in `scripts/fleet.ts`) |

## Web variables

Set in `vars` in `apps/web/wrangler.jsonc`.

| Variable | Default | Meaning |
|---|---|---|
| `ORDER_ROUTES` | `""` | Inbound orders: JSON object from `model:channel` or `model:*` to a flow id, overriding the built-in routes (`DEFAULT_ORDER_ROUTES` in `packages/core/src/inbound.ts`: `b2c:pos` and `d2c:pos` → `tpl-pos-sale`) key by key. Keys are lowercase letters, digits and underscores (`*` allowed after the colon); entries with another key or an empty flow id are dropped, as is a value that isn't a JSON object. A route that isn't set starts the model's default flow. See [Inbound orders](https://docs.orderloop.app/guides/inbound-orders/#routing) |
| `DEMO_MODE` | `""` | `"true"` only on a demo deployment, where `scripts/fleet.ts` sets it (see [The demo](operations.md#the-demo)). The sign-in page offers one-click sign-in as the shared `demo@orderloop.app` operator, who never owes two-factor setup; changes on Team and Account, `/oauth/authorize`, integrations and webhook subscriptions answer `403` (`apps/web/app/lib/demo.server.ts`); the flow templates are checked on every load, since the nightly reset removes them |
| `EDI_PARTNERS` | `""` | EDI 850s: JSON object from a trading partner's ISA sender id to the customer id it orders for, e.g. `{ "NORTHWIND": "cus_northwind" }`. A sender not listed is refused with `403`. See [Channel adapters](https://docs.orderloop.app/guides/channel-adapters/#edi-x12-850) |

## Web secrets

Set with `pnpm --filter @orderloop/web exec wrangler secret put <NAME>`, or in `apps/web/.dev.vars`
for local dev (copy `apps/web/.dev.vars.example`).

| Secret | Meaning |
|---|---|
| `SETUP_TOKEN` | The deployment's one-time setup code: on `/setup` it creates an admin account, once (its SHA-256 is recorded in `workspace_settings` as `setup_code_used`). `scripts/provision.sh` generates it into `.secrets/<id>/setup-code` and `scripts/setup-code.sh` replaces it to recover admin access. Unset, `/setup` creates nobody. See [Sign-in setup and open mode](deploy.md#sign-in-setup-and-open-mode) |
| `STRIPE_WEBHOOK_SECRET` | The signing secret (`whsec_…`) of the Stripe webhook endpoint that points at `POST /api/v1/webhooks/stripe`; the route verifies `Stripe-Signature` with it and answers `503` while it is unset. For local dev it is the secret `stripe listen` prints. Deploys pass it from the deployment's GitHub environment (`SECRETS.web` in `scripts/fleet.ts`). See [Stripe webhook](deploy.md#stripe-webhook) |
| `SHOPIFY_WEBHOOK_SECRET` | The Shopify app's client secret; enables `POST /api/v1/channels/shopify/orders`, which verifies `X-Shopify-Hmac-Sha256` with it. Unset answers `503`. See [Channel adapters](https://docs.orderloop.app/guides/channel-adapters/#shopify) |

Outbound webhook subscriptions and inbound integrations (the keys that sign
`POST /api/v1/webhooks/events` and `/orders`) each have their own secret, generated when they are
created through the API and stored in D1; they are not configuration.

## Bindings

| Binding | Worker | Resource |
|---|---|---|
| `DB` | engine, web | D1 database `orderloop`; migrations in `packages/db/migrations` |
| `DOCS` | engine, web | R2 bucket `orderloop-docs`: invoices, POs and inbound documents |
| `ORDER_AGENT` | engine | Durable Object `OrderAgent` (SQLite-backed), one per order |
| `ASSISTANT_AGENT` | engine | Durable Object `AssistantAgent` (SQLite-backed, migration `v2`), one per person |
| `A2A_AGENT` | engine | Durable Object `A2AAgent` (SQLite-backed, migration `v3`), one per [A2A](https://docs.orderloop.app/reference/a2a/) caller |
| `ORDER_LOOP` | engine | Workflow `orderloop-order` (class `OrderLoop`), up to 10,000 steps per instance |
| `REPLENISH` | engine | Workflow `orderloop-replenish` (class `Replenish`), scheduled `0 6 * * *` |
| Cron trigger | engine | `triggers.crons` `30 3 * * *`: `scheduled()` runs the daily [retention sweep](data-model.md#retention) |
| `AI` | engine | Workers AI |
| `ENGINE` | web | Service binding to `orderloop-engine`, entrypoint `EngineApi` |
| `OAUTH_REGISTER_LIMIT`, `OAUTH_TOKEN_LIMIT` | web | Workers rate-limit bindings (`ratelimits` in `wrangler.jsonc`): 10 requests a minute to `/oauth/register` and 60 to `/oauth/token`, per address; over the limit answers `429 slow_down` |
| `API_LIMIT`, `AGENT_LIMIT`, `WEBHOOK_LIMIT` | web | Per-caller budgets (`app/lib/rate-limit.ts`): 600 requests a minute per principal on `/api/v1` (after authentication), 300 per principal on each of `/mcp` and `/a2a` (keyed `<path>:<principal id>`), and 1,200 per integration on the signed webhooks (after the signature verifies, so a forged request can't spend a sender's budget) or per shop on Shopify's. Over the limit answers `429` with `Retry-After: 60`. A deployment's `limits` in the registry replace these numbers ([Operations](operations.md#the-registry)). Counted per Cloudflare location, so they stop a runaway client rather than meter it exactly. Without the binding (unit tests) nothing is limited |
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

Both app Workers answer `GET /health` with `{ ok: true, service }`. The web app's
`GET /health/deep` also checks D1, R2 and the engine (see
[Request routing](architecture.md#request-routing)). The web app sets `workers_dev` and
`preview_urls` to `false` too, so `orderloop.app` is its only address and the zone's rules apply to
every request.

## Runtime limits and observability

Both app Workers log and trace every request (`observability` with `head_sampling_rate` 1, invocation logs
and traces on); lower the rate once traffic makes the volume or cost matter. `limits.cpu_ms` stops a
runaway invocation: 5,000 for the web app, 10,000 for the engine (the platform default is 30,000). I/O
waits, such as model calls, don't count against it. The web app also sets `placement.mode` to `smart`, so
it runs near D1 and the engine rather than near the visitor.

Each audit write logs one JSON line, `{"type":"audit_event", …}` with the sealed row, to Workers Logs, where Logpush can carry it to a SIEM; a failed write logs `{"type":"audit_write_failed","action":…,"error":…}` instead, to alert on. Writing still never throws.
