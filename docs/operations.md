# Operations

Run the fleet: one OrderLoop deployment per customer, each with its own Workers, D1 database, R2
bucket, AI Gateway, domain and secrets, all in OrderLoop's Cloudflare account and all deployed by
CI.

The product lives on its own zone, `orderloop.app`, with the docs at `docs.orderloop.app`;
`orderloop.io` is for the marketing site. Every customer workspace is a subdomain of
`orderloop.app`, so nothing outside the product can set cookies for it.

A deployment shares nothing with another: not data, not secrets, not rate-limit counters. Isolating
a customer, choosing where their data lives and removing them are all per-deployment operations.
OrderLoop itself (`orderloop.app`) is a deployment like the others, the one in the `internal` ring.

## The registry

Each deployment is a file, `deployments/<id>.jsonc`. `scripts/fleet.ts` reads them.

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Lowercase letters, digits and dashes; matches the file name. Names that would read as part of OrderLoop (`api`, `app`, `docs`, `www`, `staging` and the rest of `RESERVED` in `scripts/fleet.ts`) are refused unless the entry sets `domain` |
| `ring` | required | `staging`, `internal`, `canary` or `general`: when CI deploys it (see [Rings](#rings)) |
| `slot` | required | A number from 1 to 999, unique across the fleet. Rate-limit namespaces are per account, so the web Worker's are `<slot>001` and `<slot>002` |
| `domain` | `<id>.orderloop.app` | The web app's custom domain |
| `suffix` | `-<id>` | Added to every resource name. `orderloop` uses `""`, so its resources keep the base names |
| `environment` | `deploy-<id>` | The GitHub environment holding the deployment's secrets. `orderloop` uses `production` |
| `d1Id` | none | The D1 database's id, written by `scripts/provision.sh` |
| `jurisdiction` | none | `eu` or `fedramp`: where D1 and R2 keep data, set when they are created |
| `limits` | none | Requests a minute per caller, replacing the base budgets it names: `api` (`/api/v1`, 600), `agents` (each of `/mcp` and `/a2a`, 300), `webhooks` (each integration, 1,200). For example `"limits": { "webhooks": 6000 }` for a customer whose ERP sends in bursts |
| `hold` | `false` | CI skips it: it stays on the version it runs now |
| `docs` | `false` | Deploy the docs site after it. Only `orderloop` sets it |

With the suffix, deployment `acme` gets these resource names:

| Resource | Name |
|---|---|
| Web Worker | `orderloop-web-acme`, at `acme.orderloop.app` |
| Engine Worker | `orderloop-engine-acme` (the web Worker's `ENGINE` binding points at it) |
| Workflows | `orderloop-order-acme`, `orderloop-replenish-acme` (Workflow names are unique per account) |
| D1 | `orderloop-acme` |
| R2 | `orderloop-docs-acme` |
| AI Gateway | `orderloop-acme` (`AI_GATEWAY_ID`) |
| OAuth KV | created on the first deploy, bound to that web Worker |

`node scripts/fleet.ts render <id>` writes `apps/engine/wrangler.<id>.json` and
`apps/web/wrangler.<id>.json`: each app's `wrangler.jsonc` with the deployment's names, ids, domain
and namespaces filled in. They sit next to `wrangler.jsonc` so relative paths (`main`,
`migrations_dir`) still resolve, and they are gitignored. The web build reads its rendered config
when `ORDERLOOP_WRANGLER_CONFIG` names it (`apps/web/vite.config.ts`). Rendering `orderloop` gives
back the base files unchanged, and `pnpm test:fleet` checks that.

## Adding a customer

1. Create `deployments/<id>.jsonc` with `id`, `ring` (usually `canary` first), the next free
   `slot` and, for EU data, `"jurisdiction": "eu"`.
2. Run `./scripts/provision.sh <id>`, logged in to `wrangler` and `gh`. It creates the D1
   database and R2 bucket (in the jurisdiction), the AI Gateway (with the `orderloop` gateway's settings:
   120 requests a minute, logs kept, no cache, authentication on), and the GitHub environment.
   It writes `d1Id` into the registry file and sets the environment's `SETUP_TOKEN`, the one-time setup code. New values are generated and saved in `.secrets/<id>/` (gitignored; the code is `.secrets/<id>/setup-code`); a secret
   the environment already has is left alone, and once the web Worker exists it sets none, since a
   generated one would replace the Worker's own on the next deploy. Re-running it is safe.
3. If `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` aren't repository secrets, add them to
   the environment. Add `SHOPIFY_WEBHOOK_SECRET`, `INTAKE_ALLOWLIST`, `SHIPPING_CARRIER_AUTH`,
   `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` there if the customer uses them (Stripe also
   needs `PAYMENTS_MODE` set to `stripe` in the engine's `vars`, and invoices through Stripe need
   the [Stripe webhook](deploy.md#stripe-webhook)). To gate this customer's deploys, add a required reviewer to the
   environment.
4. Commit the registry file and merge. CI deploys the customer in its ring, and the custom domain
   creates its DNS record in the `orderloop.app` zone.
5. Send the customer's first admin `https://<domain>/setup` and the code from
   `.secrets/<id>/setup-code`. They enter it with their email and a password of their own, which
   creates their admin account and signs them in; they add their team from there. The code works
   once. Until then the workspace refuses every request but `/setup`.

A deployment without `d1Id` stops the whole CI plan, so provision a customer before merging their
file, or merge it with `"hold": true`.

Email intake still needs Email Routing rules per deployment (see
[Email intake](deploy.md#email-intake)), pointing at that deployment's engine Worker.

## Rings

On a push to `main`, after the checks pass, CI's `plan` job runs `node scripts/fleet.ts matrix` and
deploys ring by ring: `staging`, then `internal`, then `canary`, then `general`. A ring starts only
when the one before it finished without a failure; an empty ring is skipped. Inside a ring every
deployment is its own job (`general` runs four at a time), and one deployment failing doesn't stop
the others in its ring, but it does stop later rings.

Each deployment's job, `.github/workflows/deploy.yml`, runs in that deployment's environment:

1. Render its configs and collect its secrets from the environment.
2. Record a D1 Time Travel bookmark (in the run summary) and apply migrations to its D1.
3. Deploy its engine, build and deploy its web app, each with `--secrets-file`. That adds the
   environment's secrets to the Worker and never removes one, so a secret set by hand survives.
4. Smoke-test `https://<domain>/health`, `/health/deep` and `/login`.
5. If anything fails after the engine deployed, roll back each Worker that deployed. D1 isn't
   rolled back (see [Restoring D1](deploy.md#restoring-d1)).

To gate a ring, add a required reviewer to its deployments' environments: the `canary` jobs then
wait for approval after `internal` succeeds.

## Holding and checking deployments

- **Hold a customer** on what they run now (a change freeze, an incident) with `"hold": true` in
  their file. Remove it to catch them up on the next deploy; migrations apply in order, so they
  catch up in one deploy.
- **Fleet status:** `node scripts/fleet.ts status` calls each deployment's `/health/deep` and
  prints its ring, domain and health.

## The demo

`demo.orderloop.app` is a public demo, the `demo` deployment, with `"demo": true` in its
registry file. Compared with a customer's deployment:

- **Demo data.** Each deploy loads `packages/db/seed/0001_demo.sql` after the migrations (the
  customers, catalog, stores, sellers and rates local development uses), so the dashboard's
  scenarios are there.
- **One-click sign-in.** `DEMO_MODE` is `"true"`, so the sign-in page offers **Explore the demo**,
  which signs a visitor in as the shared operator `demo@orderloop.app` (created on first use, with
  no password). People with their own account on the demo sign in below it as usual.
- **Guardrails.** Visitors can start and cancel orders, decide approvals, run scenarios and edit and
  publish flows. They can't change the Team or Account pages (people, roles, tokens, two-factor,
  sessions, settings), and integrations, webhook subscriptions and connecting apps (`/mcp`, `/a2a`)
  are closed, so the demo can't be pointed at anything outside it.
- **No spend, fast time.** Models are mocked (`AI_MODE=mock`, no AI Gateway) and waits run 1440×
  faster (`TIME_SCALE`), as in local development.
- **Nightly reset.** `.github/workflows/demo-reset.yml` runs at 04:00 UTC (and from the Actions
  tab): it stops the orders still running, applies `packages/db/reset/demo.sql` (everything
  visitors made, the audit log and the demo visitor's sessions; people, settings, integrations,
  `cus_internal`, `USD` and the price sources stay) and loads the demo data again. Durable Object
  state of old orders stays behind, unreachable once their rows are gone.

To bring it up: `./scripts/provision.sh demo`, then set `"hold": false` in `deployments/demo.jsonc`
and merge. The demo's own setup code (`.secrets/demo/setup-code`) is for you, not visitors: it creates an admin account for managing the demo.

## Recovering admin access

When no admin can sign in (everyone forgot their password, or the admins are disabled), issue a new
setup code:

```bash
./scripts/setup-code.sh <id>
```

Logged in to `wrangler` and `gh`. It writes a new code to `.secrets/<id>/setup-code` (never
printed), sets it as `SETUP_TOKEN` on the deployment's GitHub environment, so the next deploy keeps
it, and on the web Worker with `wrangler secret put`, so it works now. Send the person recovering
`https://<domain>/setup` and the code. They create a new admin account with an email not already on
the team, which is audited as `team.recovery_admin` (a wrong code as `team.setup_refused`), and
they can then reset the others. The code works once; the last active admin can never be demoted or
disabled, so recovery is only needed when the admins can't sign in.

Break-glass: recommend that each customer keeps a second admin account with two-factor sign-in on,
its credentials and recovery codes stored offline. It can be disabled any time and enabled when
needed. The setup code is the last resort.

## Removing a customer

A deployment holds only that customer's data, so removing it is the erasure:

1. Export what the contract requires first (a D1 export with
   `wrangler d1 export orderloop-<id> --remote --output <file>`, and the R2 bucket's documents).
2. Delete `deployments/<id>.jsonc` and merge, so CI stops deploying it.
3. Delete the Workers (`orderloop-web-<id>`, `orderloop-engine-<id>`, which removes their Durable
   Objects and Workflow instances), the D1 database, the R2 bucket (empty it first), the AI
   Gateway and its logs, the OAuth KV namespace, the GitHub environment and `.secrets/<id>/`.
