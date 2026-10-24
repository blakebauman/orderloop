# Deploy

Provision D1, R2 and KV, apply migrations, set secrets and deploy the catalog, engine and web Workers, plus the docs site.

OrderLoop deploys as four Workers in one Cloudflare account:

| Worker | Config | Role |
|---|---|---|
| `orderloop-catalog` | `apps/catalog/wrangler.jsonc` | The product catalog: `CatalogShard`, `CatalogMeta` and `CatalogFeeds` Durable Objects, the `orderloop-catalog-feed` Workflow, `ListingIndexer`, `SearchShard` and `CatalogPublisher` Durable Objects, queues for feed parts (`orderloop-catalog-feed-parts`) and listing changes (`orderloop-catalog-changes`), each with a dead-letter queue, an R2 bucket (`orderloop-catalog`) and a KV namespace for what it publishes, and it binds Order Loop's D1 database to keep variant names and prices in `products` (migration `0043` adds `catalog_at`, so it applies before this Worker deploys). No public URL and no secrets; catalog-edge binds to it (`SearchApi`, for keyword search) and the web app (`CatalogApi`, for `/api/v1/catalog`) |
| `orderloop-catalog-edge` | `apps/catalog-edge/wrangler.jsonc` | The public, read-only catalog API at `catalog.orderloop.app` (custom domain): reads the catalog's R2 bucket and KV namespace behind Workers Caching, calls the catalog's `SearchApi` for keyword search through a service binding, consumes the purge queue (`orderloop-catalog-purge`, with a dead-letter queue) and writes request data points to an Analytics Engine dataset (`orderloop_catalog_edge`). No secrets |
| `orderloop-engine` | `apps/engine/wrangler.jsonc` | OrderAgent and AssistantAgent Durable Objects, `orderloop-order` and `orderloop-replenish` Workflows, Workers AI. No public URL (`workers_dev` and preview URLs are off); reached only through the web app's service binding |
| `orderloop-web` | `apps/web/wrangler.jsonc` | Dashboard, editor, REST API. Binds the engine as `ENGINE` (entrypoint `EngineApi`) and the catalog as `CATALOG` (entrypoint `CatalogApi`, for `/api/v1/catalog`) |

The engine and web bind the same D1 database (`orderloop`) and R2 bucket (`orderloop-docs`). The catalog binds the same D1
database too, to write variant names and prices into `products`, but not the R2 bucket; catalog-edge binds neither. The catalog and catalog-edge share the catalog's R2 bucket, KV namespace and purge queue, and catalog-edge binds the catalog Worker as a service.

## First deploy

```bash
pnpm exec wrangler login
./scripts/provision.sh orderloop               # creates D1 `orderloop`, R2 `orderloop-docs` and `orderloop-catalog`, KV `orderloop-catalog-cards`, the feed-parts, purge and changes queues and their dead-letter queues, a 30-day expiry for `feeds/` in `orderloop-catalog`, the AI Gateway and the GitHub environment; safe to re-run
pnpm --filter @orderloop/web db:migrate:remote
pnpm run deploy                                # catalog, then catalog-edge, then engine (web binds to it), then web
```

Production has no demo data (migration `0027` removed it and `packages/db/seed` is never applied remotely), so the
dashboard's demo scenarios are hidden and only `USD` orders are accepted until an exchange rate is added to `fx_rates`.

`provision.sh` records the database id (`d1Id`) and the catalog's KV namespace id (`catalogKvId`) in
`deployments/orderloop.jsonc`; put the first in the `d1_databases` entry of both the engine's and the web
app's `wrangler.jsonc`, and the second in the `CARDS` entry of the catalog's, since `orderloop`
renders them unchanged (`pnpm test:fleet` fails when they differ).
Change the web app's `routes` to your own hostname. To add a customer's deployment instead, see
[Operations](operations.md#adding-a-customer).

Use `pnpm run deploy`, not `pnpm deploy`: the bare form is pnpm's built-in `deploy` command and does
something else entirely.

### Order matters

1. **Migrations before code.** Apply remote D1 migrations before deploying code that reads a new
   table or column. Until the new Workers are live, the old code runs against the new schema, so a
   migration only adds (expand); dropping or renaming waits for a later change once nothing
   deployed uses it (contract).
2. **Catalog, then catalog-edge, then plugins, then engine, then web.** The engine and the web Worker bind each installed plugin (`PLUGIN_<ID>`), so a plugin goes before them; a deployment with none skips that step. A sandboxed plugin has no Worker; its bundle is published to the deployment's `DOCS` bucket and pinned in the engine's config in that step, before the engine deploys. The web Worker's service bindings need the
   engine and the catalog to exist. Catalog-edge and the web app call the catalog (their `CATALOG` service bindings need the
   catalog to exist, which is why the catalog goes first); it goes first so that the Workers that come to
   bind to it always find the version they expect. Catalog-edge goes next because its queue
   consumer needs the purge queue (which `provision.sh` creates) and it reads what the catalog
   publishes; the catalog's `PURGE` producer needs the same queue, and its `CHANGES` producer and consumer need the changes queue.

Workflow names (`orderloop-order`, `orderloop-replenish`, `orderloop-catalog-feed`) and queue names must be unique in the account. The catalog's and catalog-edge's queue consumers need their queues to exist, so run `provision.sh` before the first deploy that carries the feed code, the purge queue or the changes queue; an existing deployment re-runs it (see [Operations](operations.md#adding-a-customer)).

## Email intake

To start orders from email ([Email intake](https://docs.orderloop.app/guides/email-intake/)), Cloudflare
Email Routing delivers mail for the intake addresses to the engine Worker's `email()` entrypoint
(`apps/engine/src/email.ts`); what to accept is decided in `packages/core/src/intake.ts`.

Email Routing needs the zone's MX records, so it replaces any other mail provider on that domain.
Use a subdomain (for example `orders.example.com`) if the apex already receives mail.

1. Deploy the engine first. A rule can only point at a Worker that exists.
2. In the dashboard under **Email → Email Routing**, enable it for the zone. This adds Cloudflare's
   MX records, an SPF record (`v=spf1 include:_spf.mx.cloudflare.net ~all`) and a DKIM record, and
   offers to remove conflicting MX records. Through the API it is
   `POST /zones/<zone_id>/email/routing/dns`.
3. Add a routing rule for each address with the action **Send to a Worker** → `orderloop-engine`.
   A literal rule matches one address, so add a rule for every address you want to receive,
   including any `+tag` variants. The defaults are `orders@`, `po@` and `purchasing@`; change the
   mapping with `INTAKE_MAILBOXES` ([Configuration](configuration.md#engine-variables)).
4. Set the catch-all to **Drop**, so mail to other addresses is never accepted.
5. Optionally, set the allowed senders:
   `pnpm --filter @orderloop/engine exec wrangler secret put INTAKE_ALLOWLIST`.

Only the first `Authentication-Results` header counts, and only when its authserv-id is
`mx.cloudflare.net` (Email Routing's own). If `email()` throws (D1, R2 or the engine failing,
rather than a rejection), it logs `email intake failed` and rethrows, so Email Routing answers with
a temporary failure and the sender's server retries. The raw message is stored in R2 at
`orders/<orderId>/inbound/message.eml`; every message is logged in `inbound_emails`. Email Routing
only allows a reply to a message that passed DMARC, so a failed acknowledgement is logged and never
fails the intake.

To test without a mail server, call `receiveEmail` from a test with a fake
`ForwardableEmailMessage`, as `apps/engine/tests/email.test.ts` does.

## Channel adapters

- **Shopify** ([Channel adapters](https://docs.orderloop.app/guides/channel-adapters/#shopify)): put the
  Shopify app's client secret on the web Worker with
  `pnpm --filter @orderloop/web exec wrangler secret put SHOPIFY_WEBHOOK_SECRET` (for local dev,
  `SHOPIFY_WEBHOOK_SECRET` in `apps/web/.dev.vars`). Until it is set the route answers `503`. The
  integrator creates the `orders/create` webhook in Shopify, pointing at
  `https://orderloop.app/api/v1/channels/shopify/orders`.
- **EDI X12 850** ([Channel adapters](https://docs.orderloop.app/guides/channel-adapters/#edi-x12-850)):
  map each trading partner's ISA sender id (`ISA06`) to a customer id in `EDI_PARTNERS`, in `vars`
  in `apps/web/wrangler.jsonc`, for example `{ "NORTHWIND": "cus_northwind" }`. A sender that isn't
  listed is refused with `403`.

The mapping is pure code in `packages/core/src/channels/` (`shopify.ts`, `x12.ts`); the web Worker
verifies, looks up the customer and starts the order.

## Stripe webhook

A deployment with `PAYMENTS_MODE` `stripe` whose flows issue invoices through Stripe
(`commerce.invoice` with provider `stripe`) needs Stripe's events to settle them and resume orders.
In the Stripe Dashboard (Developers → Webhooks), add an endpoint at
`https://<domain>/api/v1/webhooks/stripe` (orderloop.app's is
`https://orderloop.app/api/v1/webhooks/stripe`) on the same account and mode (live or test) as
`STRIPE_SECRET_KEY`, and enable these events:

- `invoice.paid`: settles the invoice and delivers `payment.received`
- `payment_intent.canceled`: marks the authorization `voided`
- `charge.dispute.created`: delivers `payment.disputed` to a waiting node

Put the endpoint's signing secret in the deployment's GitHub environment as `STRIPE_WEBHOOK_SECRET`;
the next deploy sets it on the web Worker. Until it is set the route answers `503`, and Stripe
retries. For local development, run
`stripe listen --forward-to localhost:5173/api/v1/webhooks/stripe --events invoice.paid,payment_intent.canceled,charge.dispute.created`
and put the `whsec_…` it prints in `apps/web/.dev.vars`. Rolling the secret in the Dashboard is safe:
during the overlap Stripe signs with both, and either passes.

## Agentic checkout

[Agentic checkout](https://docs.orderloop.app/reference/ucp/) needs two settings on the engine before a
platform can pay and follow its orders; the checkout flow and the platforms are then set by an admin
in the app (`/api/v1/ucp`).

- `"payments": "stripe"` and `stripePublishableKey` in the deployment's registry file
  ([operations](operations.md)): the `pk_…` key of the same Stripe account and mode as
  `STRIPE_SECRET_KEY`, rendered into the engine's `STRIPE_PUBLISHABLE_KEY`. With `payments`
  `stripe` and no key, the profile offers no payment handler.
- `UCP_SIGNING_KEY` (engine secret): a private P-256 JWK with a `kid`. Without it the profile has no
  `keys` and order events are not sent. Add it to the deployment's GitHub environment secrets, like
  `STRIPE_SECRET_KEY`; the deploy job passes it to the engine (`scripts/fleet.ts secrets engine`).

Migration `0039_ucp.sql` only adds tables, so it is safe to apply before the code that uses it.
See [Configuration](configuration.md#engine-secrets).

## Settings for production

- `TIME_SCALE` is `"1"` (real time) in `apps/engine/wrangler.jsonc`. Only local dev compresses
  waits; don't raise it on a deployment that real orders use.
- Model calls go through the `orderloop` AI Gateway (`AI_GATEWAY_ID`): request logs (prompts and responses; `aiGatewayLogs` in the registry, default on) kept up to 100,000 entries (oldest deleted first), no caching, authentication on, 120 requests a minute (sliding). It is created once per account, in the dashboard (**AI** > **AI Gateway**) or with the AI Gateway API; change its limits there. `provision.sh` creates it with the registry's `aiGatewayLogs` and only warns if an existing gateway's setting differs.
- After the first deploy, open `/setup`, enter the setup code (`SETUP_TOKEN`; `provision.sh` saved
  it in `.secrets/<id>/setup-code`), and create the first admin. Then open **Team**, add people
  with their roles, and create API tokens for other systems. See
  [Team and roles](https://docs.orderloop.app/guides/team-and-roles/).

## Sign-in setup and open mode

There is no shared password. A deployed workspace with no people is waiting for its first admin:
every request except `/setup`, `/assets/*` and `/health*` is refused (`awaitingSetup` in
`apps/web/app/lib/auth.server.ts`, checked in `apps/web/workers/app.ts`). A browser `GET` that
accepts HTML is redirected (`302`) to `/setup`; anything else gets `503
{ "error": "This workspace is not set up yet." }`.

`/setup` (`apps/web/app/routes/setup.tsx`, `apps/web/app/lib/setup.server.ts`) takes the setup code
(`SETUP_TOKEN`), an email, an optional name and a password (10 or more characters), creates an
**admin** and signs them in, redirecting to `/team`. The code works once: its SHA-256 is recorded
in `workspace_settings` under `setup_code_used`, claimed atomically before the account is created
and released if creation fails (a bad email or password, or an email already on the team). A wrong
code is throttled per address (throttle kind `setup-ip`, 10 per 15 minutes) and audited as
`team.setup_refused`. The first admin is audited `team.first_admin`; with people already on the
team, a new code creates another admin, audited `team.recovery_admin`. See
[Recovering admin access](operations.md#recovering-admin-access).

On `localhost`, `127.0.0.1`, `[::1]` and `*.localhost` (`isLocalHost` in
`apps/web/app/lib/origin.ts`) a workspace with no people is still open as an admin, which is the
local development default. To turn sign-in on locally, open **Set up sign-in** in the account menu
(the Team page) and create an admin account with a password you choose; from then on everyone signs
in. The last active admin can never be demoted or disabled.

All settings are listed in [Configuration](configuration.md).

## CI

Production deploys from CI: merging to `main` is the release. `.github/workflows/ci.yml` runs lint,
type-check, build, tests, the fleet tests (`pnpm test:fleet`), the Claude Code toolkit's tests
(`pnpm test:toolkit`) and `pnpm audit --prod --audit-level high` on every push and pull request. On `main` it then deploys
every deployment in `deployments/`, ring by ring ([Operations](operations.md#rings)). Each
deployment's job (`.github/workflows/deploy.yml`) records a D1 Time Travel bookmark, migrates its
D1, deploys its catalog, deploys its catalog-edge, deploys each [plugin](plugins.md) (its D1 migrations, then its Worker; a sandboxed plugin's bundle is published and pinned instead), deploys its engine, deploys its web app, smoke-tests `/health`, `/health/deep` and `/login` on the app's host and `https://$CATALOG_DOMAIN/health` on the catalog's,
checks their latency (the best of three requests to `/login`, `/health/deep` and the catalog's
`/health` against budgets of 1.5 s, 1 s and 0.5 s; over budget is a warning on the run, never a
failure or a rollback) and, for `orderloop` only, deploys these docs, in that order, so a change never reaches a
deployment before its migration. If anything fails once the catalog has deployed (the engine deploy,
the web deploy or the smoke test), the job runs `wrangler rollback` for each Worker that deployed;
the plugins, catalog-edge and then the catalog go last, and one with no earlier version (a deployment's first) is left as it is. D1 is not rolled
back, which is why migrations only add; see [Restoring D1](#restoring-d1). The docs then get their
own smoke test, on the host in `apps/docs/wrangler.jsonc`: the home page with its canonical URL, a
reference page, `/openapi.json` as an OpenAPI 3.1 document, and a real `404` for an unknown page.
If it fails, only the docs Worker is rolled back; the app has already passed.

Each deployment's job runs in its GitHub environment (`production` for orderloop.app, `deploy-<id>`
for a customer; add a required reviewer there to gate its releases). It needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment or repository secrets; without
them it fails rather than skipping. The environment must have `PRINCIPAL_KEY`, the key that signs the principal header the web Worker forwards and the engine checks: `fleet.ts secrets` fails the deploy, before it migrates anything, when it is missing (`provision.sh` generates one, including for an environment that already runs). It also fails a deployment the registry says takes payments through Stripe when the environment has no `STRIPE_SECRET_KEY`, or one in the other mode (test or live) from its `stripePublishableKey`. It must also have `DATA_KEY`, which encrypts the secrets both Workers store (two-factor, webhook and integration secrets, A2A push credentials): `fleet.ts secrets` fails the deploy before it migrates when it is missing too, and `provision.sh` generates it beside `PRINCIPAL_KEY`. `deploy.yml` passes both to the web and engine Workers. `PRINCIPAL_KEY_PREVIOUS` and `DATA_KEY_PREVIOUS` are set only during a rotation ([principal key](operations.md#rotating-the-principal-key), [data key](operations.md#rotating-the-data-key)). The environment's `SETUP_TOKEN`,
`SHOPIFY_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`, `OIDC_CLIENT_SECRET` (single sign-on; see [operations](operations.md#single-sign-on)), `INTAKE_ALLOWLIST`, `SHIPPING_CARRIER_AUTH` and `STRIPE_SECRET_KEY`, when set, go to the Workers with each deploy. The workflow's token is read-only
(`permissions: contents: read`), actions are pinned to commit SHAs (Dependabot updates them), and a
push to `main` never cancels a run already on its way to production.

Each deploy step runs through a small `retry` helper (three attempts, 15 then 30 seconds apart),
because the Cloudflare API occasionally fails a request outright (codes `7403`, `10013`) and every
step is safe to repeat. If the job still fails, re-run its failed jobs in GitHub Actions rather
than deploying from a laptop. The manual commands under [First deploy](#first-deploy) are for
setting up a new account.

### Restoring D1

Before it migrates, the deploy job records the database's current Time Travel bookmark in the run's
summary (and as a notice annotation). To put D1 back to the moment before a deploy, for example
after a migration that corrupted rows, restore to that bookmark:

```bash
pnpm --filter @orderloop/web exec wrangler d1 time-travel restore orderloop --bookmark=<bookmark>
```

For a customer's deployment the database is `orderloop-<id>`.

A restore replaces the whole database, so every write since the bookmark is lost: orders started,
approvals decided and audit events after that point. Roll the Workers back first if the deployed
code needs the newer schema. Time Travel keeps 30 days; for any other point in that window,
`wrangler d1 time-travel info orderloop --timestamp=<RFC3339>` finds its bookmark. Durable Object
state (live order state, assistant conversations) is not part of D1 and isn't restored.

### AI evals

`.github/workflows/evals.yml` runs the AI evals ([Testing](testing.md#evals)) against the live
models on Mondays at 06:00 UTC, from the Actions tab (`workflow_dispatch`), and on pull requests
that touch `apps/engine/src/ai.ts`, `apps/engine/wrangler.jsonc`,
`apps/engine/evals/**`, or `packages/core/src/` `redact.ts`, `untrusted.ts` or `provenance.ts`. It
uses the repository's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN` secrets (an API token with only
the Workers AI Read permission; it falls back to `CLOUDFLARE_API_TOKEN`, which as a deploy token
usually can't call Workers AI, so every case fails with a 401 fallback) and writes a table
of every case to the run summary. It is not a required check, by design: a model is not
deterministic. Run it and read it before changing a `*_MODEL` var or a prompt.

## The docs site

The public docs, docs.orderloop.app, are `apps/docs` (`@orderloop/docs`), a static Starlight site served by a static-assets
Worker, `orderloop-docs`, with no runtime code. `apps/docs/public/_headers` caches the fingerprinted
`/_astro/*` files for a year (`immutable`).

```bash
pnpm docs:dev       # local preview
pnpm docs:build     # static build into apps/docs/dist
pnpm docs:deploy    # build, then wrangler deploy
```

The reference pages (node catalog, built-in flows, event and status lists) and the
[OpenAPI explorer](https://docs.orderloop.app/api/) render from the source at build time, so rebuild and redeploy the docs
whenever those change.
