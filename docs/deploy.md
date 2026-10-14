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
./scripts/provision.sh                         # creates D1 `orderloop` and R2 `orderloop-docs`; safe to re-run
pnpm --filter @orderloop/web db:migrate:remote
pnpm --filter @orderloop/web exec wrangler secret put APP_PASSWORD
pnpm --filter @orderloop/web exec wrangler secret put WEBHOOK_SECRET
pnpm run deploy                                # engine first (web binds to it), then web
```

If `provision.sh` prints a `database_id`, put it in the `d1_databases` entry of both
`wrangler.jsonc` files. Change the web app's `routes` to your own hostname.

Use `pnpm run deploy`, not `pnpm deploy`: the bare form is pnpm's built-in `deploy` command and does
something else entirely.

### Order matters

1. **Migrations before code.** Apply remote D1 migrations before deploying code that reads a new
   table or column.
2. **Engine before web.** The web Worker's service binding needs the engine to exist.

Workflow names (`orderloop-order`, `orderloop-replenish`) must be unique in the account.

## Email intake

To start orders from email ([Email intake](https://docs.orderloop.io/guides/email-intake/)), Cloudflare
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

- **Shopify** ([Channel adapters](https://docs.orderloop.io/guides/channel-adapters/#shopify)): put the
  Shopify app's client secret on the web Worker with
  `pnpm --filter @orderloop/web exec wrangler secret put SHOPIFY_WEBHOOK_SECRET` (for local dev,
  `SHOPIFY_WEBHOOK_SECRET` in `apps/web/.dev.vars`). Until it is set the route answers `503`. The
  integrator creates the `orders/create` webhook in Shopify, pointing at
  `https://orderloop.io/api/v1/channels/shopify/orders`.
- **EDI X12 850** ([Channel adapters](https://docs.orderloop.io/guides/channel-adapters/#edi-x12-850)):
  map each trading partner's ISA sender id (`ISA06`) to a customer id in `EDI_PARTNERS`, in `vars`
  in `apps/web/wrangler.jsonc`, for example `{ "NORTHWIND": "cus_northwind" }`. A sender that isn't
  listed is refused with `403`.

The mapping is pure code in `packages/core/src/channels/` (`shopify.ts`, `x12.ts`); the web Worker
verifies, looks up the customer and starts the order.

## Settings for production

- Set `TIME_SCALE` to `"1"` in `apps/engine/wrangler.jsonc`, or waits and timeouts stay compressed
  (the default `"1440"` turns a day into a minute).
- Set `AI_GATEWAY_ID` to route model calls through AI Gateway for caching, rate limits and logs.
- After the first deploy, sign in with no email and `APP_PASSWORD` (users see it as "the workspace
  password"), open **Team** and add people with their roles, and create API tokens for other
  systems. `APP_PASSWORD` stays as a break-glass operator sign-in. See
  [Team and roles](https://docs.orderloop.io/guides/team-and-roles/).

## Sign-in setup and open mode

With `APP_PASSWORD` set, sign-in is required from the start; the form sends no email, and the REST
API's equivalent is the password as a bearer token.

A deployment with no `APP_PASSWORD` and no people is open: everyone acts as an operator, which is
the local development default. Open mode runs only on `localhost`, `127.0.0.1`, `[::1]` and
`*.localhost`; any other host answers every request except `/health` with `503` and the text
"Sign-in is not set up. Set the APP_PASSWORD secret, sign in with it, and add the first operator on
the Team page." (`openModeRefused` in `apps/web/app/lib/auth.server.ts`, `isLocalHost` in
`apps/web/app/lib/origin.ts`). To turn sign-in on locally, open **Set up sign-in** in the account
menu (the Team page) and create an operator account with a password you choose; from then on
everyone signs in. Without `APP_PASSWORD`, the last active operator can't be demoted or disabled.

All settings are listed in [Configuration](configuration.md).

## CI

Production deploys from CI: merging to `main` is the release. `.github/workflows/ci.yml` runs lint,
type-check, build and tests on every push and pull request. On `main` it then migrates D1, deploys
the engine, deploys the web app, smoke-tests `/health` and deploys these docs, in that order, so a
change never reaches production before its migration. The deploy job needs the repository secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; without them it does nothing.

Each deploy step runs through a small `retry` helper (three attempts, 15 then 30 seconds apart),
because the Cloudflare API occasionally fails a request outright (codes `7403`, `10013`) and every
step is safe to repeat. If the job still fails, re-run its failed jobs in GitHub Actions rather
than deploying from a laptop. The manual commands under [First deploy](#first-deploy) are for
setting up a new account.

## The docs site

The public docs, docs.orderloop.io, are `apps/docs` (`@orderloop/docs`), a static Starlight site served by a static-assets
Worker, `orderloop-docs`, with no runtime code.

```bash
pnpm docs:dev       # local preview
pnpm docs:build     # static build into apps/docs/dist
pnpm docs:deploy    # build, then wrangler deploy
```

The reference pages (node catalog, built-in flows, event and status lists) and the
[OpenAPI explorer](https://docs.orderloop.io/api/) render from the source at build time, so rebuild and redeploy the docs
whenever those change.
