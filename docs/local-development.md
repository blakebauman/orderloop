# Local development

Install the monorepo, apply the D1 migrations and demo data locally, run the web app and engine together, and start a scenario.

OrderLoop is a pnpm + Turborepo monorepo. Local development runs both Workers in one Vite session:
the web app, and the engine as a Vite auxiliary Worker, so the `ENGINE` service binding, the
OrderAgent Durable Objects and both Workflows all work on your machine.

## Requirements

- Node.js 22.18 or later (`.nvmrc`): the repo's scripts run `.ts` files directly, which needs Node's
  built-in type stripping. pnpm's version is pinned in the root `package.json`.
- `jq`, for the Claude Code hooks in `.claude/` (`brew install jq`). Without it they do nothing,
  including the guards that stop hand deploys, and `pnpm test:toolkit` fails.
- A Cloudflare account, if you want live AI. Workers AI always calls your account, even in local dev.
  Without one, set `AI_MODE` to `"mock"` (see [Configuration](configuration.md)).

## Install and run

```bash
git clone https://github.com/blakebauman/orderloop
cd orderloop
pnpm install
pnpm db:migrate:local      # applies packages/db/migrations to the local D1
pnpm db:seed:local         # loads the demo data from packages/db/seed (optional, safe to re-run)
pnpm web:dev               # web + engine in one Vite session
```

Open the URL Vite prints (`http://localhost:5173` by default). With no people added, the dashboard and the API are
open (on localhost only; a deployed host redirects to `/setup` until its first admin exists); **Set up sign-in** in the account menu creates the first admin and turns sign-in on; that admin (and any operator) must then set up two-factor sign-in on the Account page before using anything else, unless an admin sets the requirement to Nobody on the Team page (see
[Team and roles](https://docs.orderloop.app/guides/team-and-roles/)).

The first request that needs a flow seeds the [built-in flows](https://docs.orderloop.app/guides/templates/) and publishes
each as a new version when its content hasn't been published before (version 1 on a fresh database).

## Run a scenario

Migrations create no customers, products, stores or exchange rates beyond `USD`: `0027_remove_demo_data.sql`
removed what the early migrations had seeded, so a fresh database has none of the demo data. `pnpm db:seed:local`
loads it from `packages/db/seed/0001_demo.sql` (`INSERT OR IGNORE`, so it can be re-run): the demo customers, the
catalog, sellers, stores and their stock, contract prices, price rules, and the EUR, GBP and CAD rates. The web
app offers the scenarios only when that data is loaded (`demoAvailable()` in
`apps/web/app/lib/orders.server.ts` checks that every scenario customer and SKU exists, cached for a minute).
Without it the dashboard's **Demo scenarios** panel and the `/orders/scenarios` page are hidden (the page
answers 404), and a flow's **Test run** starts an empty order. The New order form always starts blank and
never sends `meta.simulate`; only a scenario does, from the server's list (`startScenario`,
`apps/web/app/lib/scenarios.server.ts`), and **Edit first** fills the form from a scenario without it.
The engine honours `meta.simulate` because dev sets `SIMULATE_FAILURES=true` (`apps/web/vite.config.ts`);
production leaves it off and drops the field for every caller.

With the demo data loaded, the dashboard lists 15 one-click scenarios, each a real order on a seeded flow: a guest checkout, a B2B purchase order
read from an email, an order over its credit limit, an out-of-stock order that rolls back, a purchase
request, a stock review, two subscriptions (one with a failing card), a marketplace order with two sellers,
buy online and pick up in store, a ship-from-store order with an e-book, a shipment split between the warehouse and a store, a till sale with a gift card,
a retail order that is returned and one priced in euros. Start one and the
order page opens: the flow graph colours each node as it runs, waits and finishes, and the timeline
records every step. The overview shows where open orders are waiting in each flow and what ended
badly this week; the **Performance** page shows, in USD over 7, 30 or 90 days, revenue, orders ended
and money collected per day, completion rate by model, refund rate and the slowest steps by p95
duration.

Waits are compressed in development. `pnpm web:dev` sets the engine's `TIME_SCALE` to `1440`
(`apps/web/vite.config.ts`; deployed, it is `1`), which divides every wait and timeout, so a day
becomes a minute and a 30-day return window closes in about half an hour.

Some orders stop at an approval or wait for an event. Decide approvals from the order page or the
**Approvals** inbox; deliver events (for example `payment.received`) from the order page, the
[REST API](https://docs.orderloop.app/reference/rest-api/) or a [signed webhook](https://docs.orderloop.app/guides/approvals-and-events/).

## Start an order over the API

```bash
curl -s http://localhost:5173/api/v1/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{
    "flowId": "tpl-storefront-order",
    "input": {
      "model": "b2c",
      "channel": "web",
      "customerId": "cus_ada",
      "lines": [{ "sku": "MON-27", "qty": 1 }]
    }
  }'
# → 201 { "orderId": "ord_…" }   (a repeat with the same key: 200, same orderId)
```

Then read its live state with `GET /api/v1/orders/:id`.

## Checks

```bash
pnpm test            # core planner tests (node), engine Workflow e2e and catalog and catalog-edge (workerd), web tests
pnpm lint            # Biome
pnpm check-types     # tsc --noEmit (web runs react-router typegen first)
pnpm test:fleet      # the deployment registry and the configs rendered from it
pnpm test:toolkit    # the .claude/ toolkit: skill and agent lint, hook tests

pnpm --filter @orderloop/core test                        # one package
pnpm --filter @orderloop/engine exec vitest run --project engine tests/ucp.test.ts  # one file
pnpm turbo run lint check-types test --filter='...[origin/main]'  # what changed, plus dependents
```

`pnpm engine:dev` runs the engine Worker on its own (`wrangler dev`, port 8788), without the web
app; `pnpm web:dev` already runs it inside the Vite session.

After changing a `wrangler.jsonc`, regenerate that app's binding types with
`pnpm --filter @orderloop/engine types`, `pnpm --filter @orderloop/web types`,
`pnpm --filter @orderloop/catalog types` or `pnpm --filter @orderloop/catalog-edge types`.

`pnpm web:dev` doesn't start the catalog Worker, so `/api/v1/catalog/*` fails locally unless it is running (the web app's `CATALOG` service binding resolves to it by name). Run it on its own with
`pnpm --filter @orderloop/catalog dev` (port 8789); its tests run in `pnpm test` with local R2, KV and
Durable Objects (including the changes queue and the listing indexers; a test runs an indexer's alarm itself instead of waiting out the 15 second debounce).

`pnpm web:dev` doesn't start catalog-edge either. Run it with `pnpm --filter @orderloop/catalog-edge dev`
(port 8790). It reads R2 and KV through `wrangler dev`'s local storage, which the catalog Worker
(port 8789) doesn't share by default, so a local catalog-edge serves what its own storage holds
(tests write it directly). Search calls the catalog through its service binding, so locally it
needs the catalog Worker running too, and a `search` request fails without it (the tests stub the
catalog Worker). There is no Workers Caching locally: every request runs `Delivery`, and
`purge` does nothing. Its tests run in `pnpm test`.

## Next

- [Concepts](https://docs.orderloop.app/start/concepts/): flows, versions, orders, waits and rollback.
- [Building flows](https://docs.orderloop.app/guides/building-flows/): the editor and the rules a flow must follow.
- [Deploy](deploy.md): ship the Workers to your account.
- [Configuration](configuration.md): every variable, secret and binding.
