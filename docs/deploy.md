# Deploy

Provision D1 and R2, apply migrations, set secrets and deploy the engine and web Workers, plus the docs site.

OrderLoop deploys as two Workers in one Cloudflare account:

| Worker | Config | Role |
|---|---|---|
| `orderloop-engine` | `apps/engine/wrangler.jsonc` | OrderAgent and AssistantAgent Durable Objects, `orderloop-order` and `orderloop-replenish` Workflows, Workers AI. No public URL (`workers_dev` and preview URLs are off); reached only through the web app's service binding |
| `orderloop-web` | `apps/web/wrangler.jsonc` | Dashboard, editor, REST API. Binds the engine as `ENGINE` (entrypoint `EngineApi`) |

Both bind the same D1 database (`orderloop`) and R2 bucket (`orderloop-docs`).

## First deploy

```bash
pnpm exec wrangler login
./scripts/provision.sh orderloop               # creates D1 `orderloop`, R2 `orderloop-docs`, the AI Gateway and the GitHub environment; safe to re-run
pnpm --filter @orderloop/web db:migrate:remote
pnpm run deploy                                # engine first (web binds to it), then web
```

Production has no demo data (migration `0027` removed it and `packages/db/seed` is never applied remotely), so the
dashboard's demo scenarios are hidden and only `USD` orders are accepted until an exchange rate is added to `fx_rates`.

`provision.sh` records the database id in `deployments/orderloop.jsonc`; put it in the
`d1_databases` entry of both `wrangler.jsonc` files too, since `orderloop` renders them unchanged.
Change the web app's `routes` to your own hostname. To add a customer's deployment instead, see
[Operations](operations.md#adding-a-customer).

Use `pnpm run deploy`, not `pnpm deploy`: the bare form is pnpm's built-in `deploy` command and does
something else entirely.

### Order matters

1. **Migrations before code.** Apply remote D1 migrations before deploying code that reads a new
   table or column. Until the new Workers are live, the old code runs against the new schema, so a
   migration only adds (expand); dropping or renaming waits for a later change once nothing
   deployed uses it (contract).
2. **Engine before web.** The web Worker's service binding needs the engine to exist.

Workflow names (`orderloop-order`, `orderloop-replenish`) must be unique in the account.

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
  `https://console.orderloop.app/api/v1/channels/shopify/orders`.
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
`https://<domain>/api/v1/webhooks/stripe` (OrderLoop's own is
`https://console.orderloop.app/api/v1/webhooks/stripe`) on the same account and mode (live or test) as
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

## Settings for production

- `TIME_SCALE` is `"1"` (real time) in `apps/engine/wrangler.jsonc`. Only local dev compresses
  waits; don't raise it on a deployment that real orders use.
- Model calls go through the `orderloop` AI Gateway (`AI_GATEWAY_ID`): logs kept up to 100,000 entries (oldest deleted first), no caching, authentication on, 120 requests a minute (sliding). It is created once per account, in the dashboard (**AI** > **AI Gateway**) or with the AI Gateway API; change its limits there.
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
type-check, build, tests, the fleet tests (`pnpm test:fleet`) and
`pnpm audit --prod --audit-level high` on every push and pull request. On `main` it then deploys
every deployment in `deployments/`, ring by ring ([Operations](operations.md#rings)). Each
deployment's job (`.github/workflows/deploy.yml`) records a D1 Time Travel bookmark, migrates its
D1, deploys its engine, deploys its web app, smoke-tests `/health`, `/health/deep` and `/login`
and, for `orderloop` only, deploys these docs, in that order, so a change never reaches a
deployment before its migration. If anything fails once the engine has deployed (the web deploy or
the smoke test), the job runs `wrangler rollback` for each Worker that deployed. D1 is not rolled
back, which is why migrations only add; see [Restoring D1](#restoring-d1). The docs then get their
own smoke test, on the host in `apps/docs/wrangler.jsonc`: the home page with its canonical URL, a
reference page, `/openapi.json` as an OpenAPI 3.1 document, and a real `404` for an unknown page.
If it fails, only the docs Worker is rolled back; the app has already passed.

Each deployment's job runs in its GitHub environment (`production` for console.orderloop.app, `deploy-<id>`
for a customer; add a required reviewer there to gate its releases). It needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment or repository secrets; without
them it fails rather than skipping. The environment's `SETUP_TOKEN`,
`SHOPIFY_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`, `INTAKE_ALLOWLIST`, `SHIPPING_CARRIER_AUTH` and `STRIPE_SECRET_KEY`, when set, go to the Workers with each deploy. The workflow's token is read-only
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

## The docs site

The public docs, docs.orderloop.app, are `apps/docs` (`@orderloop/docs`), a static Starlight site served by a static-assets
Worker, `orderloop-docs`, with no runtime code.

```bash
pnpm docs:dev       # local preview
pnpm docs:build     # static build into apps/docs/dist
pnpm docs:deploy    # build, then wrangler deploy
```

The reference pages (node catalog, built-in flows, event and status lists) and the
[OpenAPI explorer](https://docs.orderloop.app/api/) render from the source at build time, so rebuild and redeploy the docs
whenever those change.
