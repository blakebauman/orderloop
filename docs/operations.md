# Operations

Run the fleet: one OrderLoop deployment per customer, each with its own Workers, D1 database, R2
bucket, AI Gateway, domain and secrets, all in OrderLoop's Cloudflare account and all deployed by
CI.

The product lives on its own zone, `orderloop.app`, with the docs at `docs.orderloop.app`. Every
customer workspace is a subdomain of `orderloop.app`, so nothing outside the product can set
cookies for it.

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
| `catalogDomain` | `catalog.<domain>` | The public catalog API's custom domain, served by `orderloop-catalog-edge` (a host name; anything else is refused). Rendered into its `routes`, and into the deploy's `CATALOG_DOMAIN`, which the smoke test requests |
| `suffix` | `-<id>` | Added to every resource name. `orderloop` uses `""`, so its resources keep the base names |
| `environment` | `deploy-<id>` | The GitHub environment holding the deployment's secrets. `orderloop` uses `production` |
| `d1Id` | none | The D1 database's id, written by `scripts/provision.sh` |
| `catalogKvId` | none | The id (32 hex characters; anything else is refused) of the catalog's KV namespace of listing cards, written by `scripts/provision.sh` (`fleet.ts set-catalog-kv`). Like `d1Id` (which the catalog's config also binds as its `DB`), required to render the catalog's config or to deploy |
| `jurisdiction` | none | `eu` or `fedramp`: where D1 and R2 (the docs and the catalog's buckets) keep data, set when they are created, and where the engine's Durable Objects (`OrderAgent`, `AssistantAgent`, `A2AAgent`) and the catalog's (`CatalogShard`, `CatalogMeta`, `CatalogFeeds`, `ListingIndexer`, `SearchShard`, `CatalogPublisher`) are created. Rendered into the engine's and the catalog's `DATA_JURISDICTION`; `renderEngine` and `renderCatalog` omit it when unset, leaving the base `""`. KV has no jurisdictions. Fixed for a deployment's life: see [Data residency](data-model.md#data-residency) |
| `limits` | none | Requests a minute per caller, replacing the base budgets it names: `api` (`/api/v1`, 600), `agents` (each of `/mcp` and `/a2a`, 300), `webhooks` (each integration, 1,200). For example `"limits": { "webhooks": 6000 }` for a customer whose ERP sends in bursts |
| `auditRetentionDays` | `400` | Whole days audit events are kept before the daily sweep archives them to the R2 bucket and deletes them; at least 90 (refused below). Rendered into the engine's `AUDIT_RETENTION_DAYS` |
| `personalDataRetentionDays` | none (kept) | Whole days after an order finishes that the daily sweep erases its buyer's personal data; at least 30 (refused below). Rendered into the engine's `PERSONAL_DATA_RETENTION_DAYS`; see [Retention](data-model.md#personal-data-on-finished-orders) |
| `auditArchiveDays` | none (kept) | Whole days (at least 1; refused below) the R2 archive keeps audit events. `provision.sh` replaces the bucket's lifecycle rule `audit-archive` (prefix `audit/`) with that expiry on every run, and removes it when unset |
| `aiPersonalData` | `redact` | `redact` or `send` (anything else is refused). `send` lets the workflow AI nodes and the assistant's `assess_order` see buyers' contact details, names and addresses; see [Personal data](data-model.md#personal-data). Rendered into the engine's `AI_PERSONAL_DATA` |
| `payments` | `mock` | `mock` or `stripe` (anything else is refused; a demo can't be `stripe`). `stripe` takes payments through Stripe with the environment's `STRIPE_SECRET_KEY`, and a deploy without that secret stops before it migrates anything. Rendered into the engine's `PAYMENTS_MODE` |
| `stripePublishableKey` | none | The Stripe publishable key (`pk_test_…` or `pk_live_…`) of the same account and mode as `STRIPE_SECRET_KEY`; only with `payments` `stripe`, and a deploy whose secret key is in the other mode stops. Agentic checkout gives it to platforms to tokenize cards with. Rendered into the engine's `STRIPE_PUBLISHABLE_KEY` |
| `assistantDailyTokens` | `1000000` | Whole number of model tokens each person's assistant conversations may use per UTC day; `0` is no limit (negative or fractional is refused). Rendered into the engine's `ASSISTANT_DAILY_TOKENS` |
| `aiGatewayLogs` | `true` | `true` or `false` (a boolean). Whether the deployment's AI Gateway keeps request logs, which hold the prompts and responses. `provision.sh` sets it when it creates the gateway |
| `sso` | none | `{ "issuer": "https://…", "clientId": "…" }`: the customer's OpenID Connect identity provider and this deployment's client id; the issuer must be an https URL and the client id non-empty (refused otherwise). Rendered into the web Worker's `OIDC_ISSUER` and `OIDC_CLIENT_ID`; the client secret is the environment's `OIDC_CLIENT_SECRET`. See [Single sign-on](#single-sign-on) |
| `plugins` | none | `{ "<plugin id>": { "d1Id": "…", "personalData": "send", "runtime": "sandboxed", "secrets": ["API_KEY"] } }`: the plugins (`plugins/<id>/`) this deployment installs. `runtime` is `worker` (the default) or `sandboxed`. A `worker` plugin is its own Worker `orderloop-plugin-<id><suffix>` and D1 database of the same name, bound to the engine and web Workers as `PLUGIN_<ID>`; `d1Id` is written by `scripts/provision.sh` (`fleet.ts set-plugin-d1`) and required to deploy. A `sandboxed` plugin has no Worker, binding or database: CI publishes its bundle and the engine loads it (Worker Loader), and a `d1Id` on one is refused. `personalData` is optional and can only be `"send"`: it grants the plugin buyer details, which its manifest can ask for but not give itself; it is rendered into the engine's `PLUGIN_GRANTS`. `secrets` lists the plugin's secret names (upper case, not `PLUGIN_KEY`, `PLUGIN_KEY_PREVIOUS`, `DB`, `SECRETS` or `STORAGE`) and is needed only with `secretsStore`, because Secrets Store bindings are per secret. Any other key, an unknown `runtime`, ids that aren't plugin ids or are the engine's own variable names (`bundles`, `secrets`, `grants`, `key`), the `example` and `fixture-carrier` fixtures, and ids without `plugins/<id>/wrangler.jsonc` are refused. A `worker` plugin's `wrangler.jsonc` may hold only vars and one D1 binding `DB`, or rendering refuses it. See [Plugins](plugins.md) |
| `secretsStore` | none | `{ "storeId": "<32 hex characters>" }` (anything else is refused): the Cloudflare Secrets Store of a deployment on its own Cloudflare account, where its plugins' secrets live as `PLUGIN_<ID>_<NAME>` instead of in the GitHub environment. Leave it out on a shared account (one store and 100 secrets an account). Rendered as `secrets_store_secrets` bindings for each plugin's listed `secrets`. See [Plugin secrets](#plugin-secrets) |
| `hold` | `false` | CI skips it: it stays on the version it runs now |
| `docs` | `false` | Deploy the docs site after it. Only `orderloop` sets it |

With the suffix, deployment `acme` gets these resource names:

| Resource | Name |
|---|---|
| Web Worker | `orderloop-web-acme`, at `acme.orderloop.app` |
| Engine Worker | `orderloop-engine-acme` (the web Worker's `ENGINE` binding points at it) |
| Catalog Worker | `orderloop-catalog-acme` |
| Catalog edge Worker | `orderloop-catalog-edge-acme`, at `catalog.acme.orderloop.app` |
| Workflows | `orderloop-order-acme`, `orderloop-replenish-acme`, `orderloop-catalog-feed-acme` (Workflow names are unique per account) |
| Plugin Worker and D1 | `orderloop-plugin-<id>-acme` for each installed plugin (the Worker and its database share the name) |
| D1 | `orderloop-acme` (bound by the engine, web and catalog Workers; the catalog writes variant names and prices into `products`) |
| R2 | `orderloop-docs-acme`, `orderloop-catalog-acme` (the catalog's published documents and feed files) |
| Queues | `orderloop-catalog-feed-parts-acme` and its dead-letter queue `orderloop-catalog-feed-parts-dlq-acme`; the purge queue `orderloop-catalog-purge-acme` and its dead-letter queue `orderloop-catalog-purge-dlq-acme`; the listing-changes queue `orderloop-catalog-changes-acme` and its dead-letter queue `orderloop-catalog-changes-dlq-acme` (queue names are unique per account) |
| Analytics Engine | dataset `orderloop_catalog_edge_acme` (dashes in the suffix become underscores) |
| Catalog KV | `orderloop-catalog-cards-acme` (the catalog's `CARDS` namespace, id in `catalogKvId`) |
| AI Gateway | `orderloop-acme` (`AI_GATEWAY_ID`) |
| OAuth KV | created on the first deploy, bound to that web Worker |

`node scripts/fleet.ts render <id>` writes `apps/catalog/wrangler.<id>.json`,
`apps/catalog-edge/wrangler.<id>.json`, `apps/engine/wrangler.<id>.json` and `apps/web/wrangler.<id>.json`, and `plugins/<plugin>/wrangler.<id>.json` for each installed plugin: each app's `wrangler.jsonc` with the deployment's names, ids, domain
and namespaces filled in. They sit next to `wrangler.jsonc` so relative paths (`main`,
`migrations_dir`) still resolve, and they are gitignored. The web build reads its rendered config
when `ORDERLOOP_WRANGLER_CONFIG` names it (`apps/web/vite.config.ts`). Rendering `orderloop` gives
back the base files unchanged, and `pnpm test:fleet` checks that.

## Adding a customer

1. Create `deployments/<id>.jsonc` with `id`, `ring` (usually `canary` first), the next free
   `slot` and, for EU data, `"jurisdiction": "eu"`. Set it now: D1, R2 and the Durable Objects take
   it at creation, so adding or changing it after the first order strands that order's live state
   (see [Data residency](data-model.md#data-residency)).
2. Run `./scripts/provision.sh <id>`, logged in to `wrangler` and `gh`. It creates the D1
   database, the R2 bucket and the catalog's R2 bucket (in the jurisdiction; the Durable Objects get theirs from each Worker's `DATA_JURISDICTION`, rendered at deploy), the catalog's KV namespace (KV has none; its id is written as `catalogKvId`), the AI Gateway (with the `orderloop` gateway's settings:
   120 requests a minute, no cache, authentication on, request logs on unless `aiGatewayLogs` is `false`), and the GitHub environment. For a gateway that already exists, it compares the gateway's log setting with `aiGatewayLogs` and prints a warning if they differ; it doesn't change the gateway, so change it in the dashboard (**AI** > **AI Gateway** > the gateway > **Settings**).
   For each plugin in the file's `plugins` it creates the D1 database `orderloop-plugin-<plugin><suffix>` and writes its id as `plugins.<plugin>.d1Id` (see [Plugins](plugins.md#installing)).
   It creates the catalog's two feed queues, the two purge queues and the two changes queues (a deploy fails while a consumer's queue doesn't exist) and adds a lifecycle rule `feeds` on the catalog bucket that expires `feeds/` (uploaded feed files and their parts) after 30 days; both are skipped with a message when they already exist.
   It also sets the R2 lifecycle rule that expires the audit archive after `auditArchiveDays`, or removes it when that is unset; re-run it after changing the number.
   It sets the environment's `PRINCIPAL_KEY` and `DATA_KEY` (`openssl rand -hex 32`, never written to disk) when it lacks them, for a deployment that already runs too, since a deploy fails without it. It writes `d1Id` into the registry file and sets the environment's `SETUP_TOKEN`, the one-time setup code. New values are generated and saved in `.secrets/<id>/` (gitignored; the code is `.secrets/<id>/setup-code`); a secret
   the environment already has is left alone, and once the web Worker exists it sets none, since a
   generated one would replace the Worker's own on the next deploy. Re-running it is safe.
3. If `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` aren't repository secrets, add them to
   the environment. Add `SHOPIFY_WEBHOOK_SECRET`, `INTAKE_ALLOWLIST`, `SHIPPING_CARRIER_AUTH`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` or `OIDC_CLIENT_SECRET` ([single sign-on](#single-sign-on)) there if the customer uses them (Stripe also
   needs `"payments": "stripe"` in the registry file, and invoices through Stripe need
   the [Stripe webhook](deploy.md#stripe-webhook)). To gate this customer's deploys, add a required reviewer to the
   environment.
4. Commit the registry file and merge. CI deploys the customer in its ring, and the custom domain
   creates its DNS record in the `orderloop.app` zone.
5. Send the customer's first admin `https://<domain>/setup` and the code from
   `.secrets/<id>/setup-code`. They enter it with their email and a password of their own, which
   creates their admin account and signs them in; they add their team from there. The code works
   once. Until then the workspace refuses every request but `/setup`.

**Deployments that predate feeds.** Provisioning only runs when you run it, and CI never does. A deployment provisioned before the catalog's feed import needs the queues and the `feeds/` rule too, and one that predates the public catalog API needs the two purge queues before the deploy that carries `catalog-edge`, and one that predates listing indexes needs the two changes queues before the deploy that carries them: run `./scripts/provision.sh <id>` again, before the deploy that carries the feed code (re-running is safe and sets no secrets once the web Worker exists). The script keeps a queue that already exists (`queues info`) and stops if one can neither be found nor created, since a deploy fails without its consumer's queue; it replaces the `feeds` lifecycle rule on each run. Keyword search needs no new resource (its Durable Objects come with the deploy and the `CATALOG` service binding resolves to the deployment's own catalog), but it fills only from changes published after it deploys: run `reindex` once for products already published. Segmented listing indexes are the same: `catalog-edge` reads only the per-segment blobs (`idx/f1/<channel>/<category>/<segment>.bin`), which exist only once listing changes reach each segment's indexer, so after the deploy that carries segmented listings, run `reindex` once per deployment (`POST /api/v1/catalog/reindex` on the web app, an `admin` call; it republishes every product, which forces every listing to rebuild). Until it has run, category listings are empty (`404`) or hold only the products changed since the deploy. The old single-blob indexes are left in R2 unread; deleting the channel sweeps them. The `orderloop` deployment's queues and `feeds` rule were created through the Cloudflare API rather than by `provision.sh` (on 2026-10-23), and so were its purge queues, `orderloop-catalog-purge` and `orderloop-catalog-purge-dlq` (also on 2026-10-23), and its changes queues, `orderloop-catalog-changes` and `orderloop-catalog-changes-dlq` (also on 2026-10-23); re-running the script for it changes nothing.

A deployment without `d1Id`, `catalogKvId` or a plugin's `d1Id` stops the whole CI plan, so provision a customer before merging their
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

1. Render its configs and collect its secrets from the environment. With plugins installed, the **Collect plugin secrets** step also writes each Worker plugin's secrets file and, for sandboxed plugins on a shared account, the engine's `PLUGIN_SECRETS`. Then **Check plugin secrets** builds each plugin's bundle, reads its manifest and fails the deploy, before anything changes, if a required (not `optional`) secret isn't set: in the environment, or on a `secretsStore` deployment listed in the registry and present in the store (names only).
2. Record a D1 Time Travel bookmark (in the run summary) and apply migrations to its D1.
3. Deploy its catalog, then its catalog-edge, then each installed plugin (its D1 migrations, then its Worker with its own `--secrets-file`: `PLUGIN_KEY` derived from `PRINCIPAL_KEY` for that plugin alone, and the environment's `PLUGIN_<ID>_*` secrets under their own names, unless the deployment has a `secretsStore`; the engine and web Worker bind to it), then **Publish sandboxed plugins** (each sandboxed plugin's bundle goes to the deployment's `DOCS` bucket as `plugins/<id>/<sha>.json` and the shas are pinned in the engine config's `PLUGIN_BUNDLES`), then its engine, then build and deploy its web app; the engine and web app
   each with `--secrets-file` (the catalog and catalog-edge have no secrets). That adds the
   environment's secrets to the Worker and never removes one, so a secret set by hand survives.
4. Smoke-test `https://<domain>/health`, `/health/deep` and `/login`, then `https://<catalogDomain>/health`.
5. If anything fails after the catalog deployed, roll back each Worker that deployed (the web app, the engine, the plugins, catalog-edge,
   then the catalog last, and not when either has no earlier version). Rolling the engine back restores its previous `PLUGIN_BUNDLES` pins; the bundles stay in `DOCS` (nothing removes them), so the old version finds the ones it pins. D1 isn't rolled back (see [Restoring D1](deploy.md#restoring-d1)).

To gate a ring, add a required reviewer to its deployments' environments: the `canary` jobs then
wait for approval after `internal` succeeds.

## Plugins

A plugin is installed by listing it under `plugins` in a deployment's file (see the registry above
and [Plugins](plugins.md)). To install one: add it, run `./scripts/provision.sh <id>` (it creates the
plugin's D1 database), and merge. To remove one from a deployment: run
`ORDERLOOP_API_TOKEN=ol_… pnpm plugin:check <id> <plugin>` with an admin's API token, which fails
while a published flow or a running order uses the plugin's nodes; take it out of `plugins` and merge
so CI deploys without it; then delete its Worker `orderloop-plugin-<plugin><suffix>` and its D1
database. Delete `plugins/<plugin>/` once no deployment lists it.

A plugin whose manifest asks for `personalData: "send"` is refused until its registry entry says
`"personalData": "send"`; merge that to grant it, and remove it to withdraw it (the plugin is refused
at once on the next deploy, even from its last good manifest). A plugin's keys are derived from
`PRINCIPAL_KEY` (`PLUGIN_KEY`) and `PRINCIPAL_KEY_PREVIOUS` (`PLUGIN_KEY_PREVIOUS`), so rotating the
principal key rotates them too, and each plugin's secrets are written per plugin
(`fleet.ts secrets plugin <out> <plugin>`). The old `PLUGIN_KEY_PREVIOUS` is not removed from the
plugin's Worker when it stops being written: run `wrangler secret delete PLUGIN_KEY_PREVIOUS`
against `orderloop-plugin-<plugin><suffix>` after the rotation.

A sandboxed plugin is installed the same way with `"runtime": "sandboxed"`: there is nothing to
provision (`provision.sh` skips it) and no Worker or database to delete on removal; take it out of
`plugins` and merge, and the engine stops loading it. Its pinned bundles stay in the `DOCS` bucket
as `plugins/<plugin>/<sha>.json`; delete them by hand if you want them gone. Its storage (the engine's
`PluginStorage` object for that id) stays too, so reinstalling finds its data. Worker Loader, which
runs sandboxed plugins, is in open beta and needs Workers Paid; the engine's `LOADER` binding is
declared in every deployment and unused until one is installed. Cloudflare enforces the per-call CPU
and subrequest limits; local workerd does not.

### Plugin secrets

A plugin's secrets are named `PLUGIN_<ID>_<NAME>` (`API_KEY` of `shipstation` is
`PLUGIN_SHIPSTATION_API_KEY`) and live where the deployment's Cloudflare account puts them
([Plugins](plugins.md#secrets)).

**Shared account** (no `secretsStore`): set `PLUGIN_<ID>_<NAME>` in the deployment's GitHub
environment (`deploy-<id>`), e.g. `gh secret set PLUGIN_SHIPSTATION_API_KEY --env deploy-acme`, and
deploy. A Worker plugin gets it as `<NAME>` in its secrets file; a sandboxed plugin's go to the
engine as `PLUGIN_SECRETS`. To rotate, change the value and redeploy (merge, or re-run the
deployment's job). `--secrets-file` never removes a secret, so one you stop setting stays on the
Worker: delete it with `wrangler secret delete <NAME>` against the plugin's Worker (or, for a
sandboxed plugin, rotate it at its issuer; `PLUGIN_SECRETS` is rewritten whole on each deploy).

**Own account** (`secretsStore` in the registry): put the secret in the account's Secrets Store
under the same `PLUGIN_<ID>_<NAME>` name, with the Workers scope, and list its `<NAME>` under
`plugins.<id>.secrets`:

```sh
wrangler secrets-store secret create <store id> --name PLUGIN_SHIPSTATION_API_KEY --scopes workers --remote
```

or use the dashboard (Secrets Store). Rotate it in the store (`wrangler secrets-store secret update`,
or the dashboard): the plugin reads the new value on its next call, with no deploy. To revoke,
delete or rotate it in the store. `provision.sh` checks the store exists (create it with
`wrangler secrets-store store create <name> --remote`; one store an account) and reminds you to add
each plugin's secrets.

The deployment's CI token (`CLOUDFLARE_API_TOKEN`) needs **Account Secrets Store Edit** for any
deployment with a `secretsStore`: **Check plugin secrets** lists the store's secret names with it
(Read is enough for that) and deploying a Worker that binds a store needs Edit. Without it the
check stops the deploy with `CLOUDFLARE_API_TOKEN needs Account Secrets Store Edit`. A deploy also
stops, naming the missing `PLUGIN_<ID>_<NAME>`, when a required secret isn't set. A required
secret removed afterwards fails the plugin's manifest, so deep health names it.

Moving a deployment onto its own account's Secrets Store: a Worker plugin's old plain secrets stay
on its Worker (`--secrets-file` never removes one), and a Secrets Store binding of the same name
then fails its deploy. Delete each first (`wrangler secret delete <NAME> --name
orderloop-plugin-<id><suffix>`), then merge the registry change. Two deployments must never share
a `secretsStore`: its names (`PLUGIN_<ID>_<NAME>`) aren't per deployment.

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
- **Failing scenarios.** `SIMULATE_FAILURES` is `"true"`, so the scenarios that fail on purpose do.
  A customer's deployment leaves it off and drops `meta.simulate` from every order.
- **Nightly reset.** `.github/workflows/demo-reset.yml` runs at 04:00 UTC (and from the Actions
  tab): it stops the orders still running, applies `packages/db/reset/demo.sql` (everything
  visitors made, the audit log (`demo.sql` drops the `audit_events_keep_90_days` trigger around the delete and recreates it) and the demo visitor's sessions; people, settings, integrations,
  `cus_internal`, `USD` and the price sources stay) and loads the demo data again. Durable Object
  state of old orders stays behind, unreachable once their rows are gone.

To bring it up: `./scripts/provision.sh demo`, then set `"hold": false` in `deployments/demo.jsonc`
and merge. The demo's own setup code (`.secrets/demo/setup-code`) is for you, not visitors: it creates an admin account for managing the demo.

## Single sign-on

A customer signs in through its own OpenID Connect provider (Okta, Entra ID, Google Workspace, …):

1. At the provider, register a web application (authorization code flow) with the redirect URI
   `https://<domain>/login/sso/callback`. Scopes `openid email profile`; PKCE is used. Note the
   issuer (as its `/.well-known/openid-configuration` names it), the client id and the client secret.
2. Add `"sso": { "issuer": "https://…", "clientId": "…" }` to the registry file, and set
   `OIDC_CLIENT_SECRET` in the deployment's GitHub environment.
3. Merge. The next deploy renders `OIDC_ISSUER` and `OIDC_CLIENT_ID` into the web Worker and sets the
   secret. With all three set the sign-in page shows **Sign in with single sign-on**.
4. Tell the customer's admins. On the Team page they choose who may join and from which email
   domains, and can turn on **Single sign-on only** once they have signed in that way themselves.

Removing `sso` from the registry (the Worker then has no issuer) turns the button off. A saved
**Single sign-on only** then has no effect (`ssoOnlyInEffect` in `settings.server.ts` needs a
configured provider), so passwords and passkeys work again; people single sign-on added have no
password and need an admin to reset one for them.
A person disabled at the provider keeps their session until it ends; an admin disabling them on the
Team page ends it now, or the provider can do it through SCIM (below).

### Provisioning (SCIM)

For a customer whose provider pushes people and groups (Okta, Entra ID), set single sign-on up first:
people SCIM creates are viewers with no password, so they can only sign in through it (linked by
email on their first sign-in). Then ask the customer's admin to open **SCIM provisioning** on the
Team page, make a token (`ol_scim_…`, shown once; only its SHA-256 is stored) and paste the
**Endpoint** (`https://<domain>/scim/v2`) and token into the provider's provisioning settings. No
registry entry, secret or deploy is involved. The admin maps pushed groups to roles on the same
page. Deactivating at the provider ends the person's sessions, connected apps and the API tokens
they made. Without a token every `/scim/v2` request is a `401`; demo deployments lock the path.

## Rotating the principal key

`PRINCIPAL_KEY` signs the principal header the web Worker forwards to the engine, and each signature
lasts 60 seconds, so a rotation needs no downtime when it runs in two deploys:

1. In the deployment's GitHub environment, set `PRINCIPAL_KEY_PREVIOUS` to the current key and
   `PRINCIPAL_KEY` to a new one (`openssl rand -hex 32`). Deploy. The engine deploys first and
   accepts both; the web Worker then signs with the new one.
2. Remove `PRINCIPAL_KEY_PREVIOUS` from the environment and deploy again.

Removing a secret from the environment does not remove it from the Worker: `fleet.ts secrets` writes
only the ones set and `--secrets-file` never deletes, so also run
`wrangler secret delete PRINCIPAL_KEY_PREVIOUS` against the deployment's engine Worker
(`orderloop-engine-<id>`), or the old key stays accepted. Each installed plugin's `PLUGIN_KEY` is derived from it, so the same two deploys rotate those ([Plugins](#plugins)).

## Rotating the data key

`DATA_KEY` encrypts the secrets a deployment stores: two-factor secrets, integration and webhook
subscription secrets, and the credentials of A2A push configs. A stored value names the key it was
sealed under, so both keys can be read during a rotation and nothing needs to be re-entered:

1. In the deployment's GitHub environment, set `DATA_KEY_PREVIOUS` to the current key and
   `DATA_KEY` to a new one (`openssl rand -hex 32`). Deploy. New writes use the new key; values
   under the old one are still read.
2. Wait for the next daily retention sweep (03:30 UTC) or longer, and check its log shows
   `secrets.unreadable` of 0. The sweep (`resealSecrets`) moves every value under
   `DATA_KEY_PREVIOUS` onto `DATA_KEY`, writing conditionally so a concurrent rotation isn't undone;
   `secrets.resealed` counts what it moved.
3. Remove `DATA_KEY_PREVIOUS` from the environment, deploy again, and also run
   `wrangler secret delete DATA_KEY_PREVIOUS` against both the deployment's web and engine Workers
   (`orderloop-web-<id>`, `orderloop-engine-<id>`): `--secrets-file` never deletes, so the old key
   would stay readable.

A2A push configs live in each `A2AAgent`'s SQLite and are resealed when loaded, not by the sweep.
A config on an idle task still under the old key is dropped once that key is gone (logged); the
caller registers its URL again.

Never lose `DATA_KEY`: values sealed under a key the deployment no longer has can't be recovered.
Two-factor must be reset for those people, and integration and webhook secrets rotated. Values stored
before encryption existed have no prefix, are read as they are, and are encrypted by the next sweep.

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
they can then reset the others. If the workspace was **Single sign-on only**, redeeming the code
turns that off (audited as `team.sso_settings` with `via: "setup code"`), so the new admin can sign
in with their password even when the identity provider is the problem. The code works once; the last active admin can never be demoted or
disabled, so recovery is only needed when the admins can't sign in.

Break-glass: recommend that each customer keeps a second admin account with two-factor sign-in on,
its credentials and recovery codes stored offline. It can be disabled any time and enabled when
needed. The setup code is the last resort.

## Removing a customer

A deployment holds only that customer's data, so removing it is the erasure:

1. Export what the contract requires first (a D1 export with
   `wrangler d1 export orderloop-<id> --remote --output <file>`, and the R2 bucket's documents, including the audit archive under `audit/`: events past `auditRetentionDays` live only there, as NDJSON with their hashes). The catalog's products live in its Durable Objects, which have no export yet; its published documents in `orderloop-catalog-<id>` are a rendered copy.
2. Delete `deployments/<id>.jsonc` and merge, so CI stops deploying it.
3. Delete the Workers (`orderloop-web-<id>`, `orderloop-engine-<id>`, `orderloop-catalog-<id>`, `orderloop-catalog-edge-<id>` and `orderloop-plugin-<plugin>-<id>` for each plugin, which removes their Durable
   Objects and Workflow instances), the D1 database, the R2 buckets (`orderloop-docs-<id>` and `orderloop-catalog-<id>`; empty them first), the catalog's KV namespace, the two feed queues, the two purge queues and the two changes queues, each plugin's D1 database (`orderloop-plugin-<plugin>-<id>`), the AI
   Gateway and its logs, the OAuth KV namespace, the GitHub environment and `.secrets/<id>/`.
