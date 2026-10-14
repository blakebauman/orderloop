# Configuration

Variables, secrets and bindings for the engine and web Workers, and the local dev files.

Both Workers are configured in their `wrangler.jsonc`. After changing one, regenerate its binding
types: `pnpm --filter @orderloop/engine types` or `pnpm --filter @orderloop/web types`.

## Engine variables

Set in `vars` in `apps/engine/wrangler.jsonc`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI text model for every structured AI call (JSON mode) |
| `ASSISTANT_MODEL` | `@cf/moonshotai/kimi-k2.6` | Workers AI model for the [assistant](https://docs.orderloop.io/guides/assistant/); it needs multi-turn tool calling |
| `ASSESS_MODEL` | `@cf/cloudflare/clef` | Workers AI decision model for [Assess](https://docs.orderloop.io/guides/ai/#assess) and the assistant's `assess_order` |
| `AI_GATEWAY_ID` | `""` | AI Gateway id for caching, rate limits and logs. Empty calls Workers AI directly |
| `AI_MODE` | `live` | `live` calls the model; `mock` uses the deterministic heuristics only (tests, offline dev) |
| `TIME_SCALE` | `1` | Divides every wait and timeout. `"1"` is real time; `pnpm web:dev` overrides it to `"1440"` (a day becomes a minute) in `apps/web/vite.config.ts`, and the engine tests use `"1"` |
| `INTAKE_MAILBOXES` | `""` | Email intake: JSON object of mailbox local part to flow id. Empty uses `orders@` and `po@` → `tpl-b2b-order`, `purchasing@` → `tpl-purchase-request` |
| `INTAKE_REQUIRE_AUTH` | `true` | `"false"` accepts mail without a passing DMARC, DKIM or SPF result. Never in production: it lets anyone who forges a customer's From address start orders |
| `INTAKE_REPLY` | `true` | `"false"` turns off the acknowledgement reply to accepted email |

## Compatibility flags

`apps/engine/wrangler.jsonc` sets `nodejs_compat` and `global_fetch_strictly_public`. The second
makes the engine's outbound `fetch` (outbound webhooks and [A2A push
notifications](https://docs.orderloop.io/reference/a2a/#push-notifications), whose URLs callers supply) reach public
addresses only, not private or loopback ones.

## Engine secrets

Set with `pnpm --filter @orderloop/engine exec wrangler secret put <NAME>`.

| Secret | Meaning |
|---|---|
| `INTAKE_ALLOWLIST` | Extra senders allowed to start orders by email: addresses or `@domains`, comma-separated. Customers' own addresses and company domains are always allowed. See [Email intake](https://docs.orderloop.io/guides/email-intake/#who-may-send) |

## Web variables

Set in `vars` in `apps/web/wrangler.jsonc`.

| Variable | Default | Meaning |
|---|---|---|
| `ORDER_ROUTES` | `""` | Inbound orders: JSON object from `model:channel` or `model:*` to a flow id, overriding the built-in routes (`DEFAULT_ORDER_ROUTES` in `packages/core/src/inbound.ts`: `b2c:pos` and `d2c:pos` → `tpl-pos-sale`) key by key. Keys are lowercase letters, digits and underscores (`*` allowed after the colon); entries with another key or an empty flow id are dropped, as is a value that isn't a JSON object. A route that isn't set starts the model's default flow. See [Inbound orders](https://docs.orderloop.io/guides/inbound-orders/#routing) |
| `EDI_PARTNERS` | `""` | EDI 850s: JSON object from a trading partner's ISA sender id to the customer id it orders for, e.g. `{ "NORTHWIND": "cus_northwind" }`. A sender not listed is refused with `403`. See [Channel adapters](https://docs.orderloop.io/guides/channel-adapters/#edi-x12-850) |

## Web secrets

Set with `pnpm --filter @orderloop/web exec wrangler secret put <NAME>`, or in `apps/web/.dev.vars`
for local dev (copy `apps/web/.dev.vars.example`).

| Secret | Meaning |
|---|---|
| `APP_PASSWORD` | A break-glass operator: sign in with no email and this password (an HttpOnly cookie, 30 days), or send it as `Authorization: Bearer <APP_PASSWORD>`. When set, sign-in is required even before anyone is added. With it unset and no people in `users`, the dashboard and API are open on localhost only (any other host answers `503`); see [Sign-in setup and open mode](deploy.md#sign-in-setup-and-open-mode) |
| `WEBHOOK_SECRET` | Enables signed inbound events at `POST /api/v1/webhooks/events` and signed orders at `POST /api/v1/webhooks/orders`. Unset answers `503` there |
| `SHOPIFY_WEBHOOK_SECRET` | The Shopify app's client secret; enables `POST /api/v1/channels/shopify/orders`, which verifies `X-Shopify-Hmac-Sha256` with it. Unset answers `503`. See [Channel adapters](https://docs.orderloop.io/guides/channel-adapters/#shopify) |

Outbound webhook subscriptions each have their own secret, generated when the subscription is
created; they are not configuration.

## Bindings

| Binding | Worker | Resource |
|---|---|---|
| `DB` | engine, web | D1 database `orderloop`; migrations in `packages/db/migrations` |
| `DOCS` | engine, web | R2 bucket `orderloop-docs`: invoices, POs and inbound documents |
| `ORDER_AGENT` | engine | Durable Object `OrderAgent` (SQLite-backed), one per order |
| `ASSISTANT_AGENT` | engine | Durable Object `AssistantAgent` (SQLite-backed, migration `v2`), one per person |
| `A2A_AGENT` | engine | Durable Object `A2AAgent` (SQLite-backed, migration `v3`), one per [A2A](https://docs.orderloop.io/reference/a2a/) caller |
| `ORDER_LOOP` | engine | Workflow `orderloop-order` (class `OrderLoop`), up to 10,000 steps per instance |
| `REPLENISH` | engine | Workflow `orderloop-replenish` (class `Replenish`), scheduled `0 6 * * *` |
| Cron trigger | engine | `triggers.crons` `30 3 * * *`: `scheduled()` runs the daily [retention sweep](data-model.md#retention) |
| `AI` | engine | Workers AI |
| `ENGINE` | web | Service binding to `orderloop-engine`, entrypoint `EngineApi` |
| `OAUTH_REGISTER_LIMIT`, `OAUTH_TOKEN_LIMIT` | web | Workers rate-limit bindings (`ratelimits` in `wrangler.jsonc`): 10 requests a minute to `/oauth/register` and 60 to `/oauth/token`, per address; over the limit answers `429 slow_down` |
| `OAUTH_KV` | web | KV namespace for [MCP](https://docs.orderloop.io/reference/mcp/) and [A2A](https://docs.orderloop.io/reference/a2a/) OAuth clients, grants and tokens (tokens hashed, grant data encrypted). `wrangler.jsonc` gives no id; the namespace is provisioned on deploy |

The web Worker's compatibility flags are `nodejs_compat` and `global_fetch_strictly_public`. The
second keeps fetches of an MCP client's Client ID Metadata Document (an https `client_id`) to the
public internet.

## Routes and hostnames

The web Worker serves `orderloop.io` as a custom domain; change `routes` in
`apps/web/wrangler.jsonc` for your own. The engine has no routes, no `workers.dev` URL and no preview
URLs: only the web app's service binding reaches it, plus Email Routing rules that send mail to it
(see [Email intake](deploy.md#email-intake)). The docs Worker (`apps/docs/wrangler.jsonc`)
serves `docs.orderloop.io`.

Both app Workers answer `GET /health` with `{ ok: true, service }`.
