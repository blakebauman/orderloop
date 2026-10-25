# Plugins

How an optional feature ships as a plugin: its own Worker and D1 database, installed per
deployment from the registry and removable without touching the core. The contract is
`packages/core/src/plugins.ts`; the engine side is `apps/engine/src/plugins.ts`, the web side
`apps/web/app/lib/plugins.server.ts`, `apps/web/app/lib/nodes.tsx` and the admin page
`apps/web/app/routes/plugins.tsx`. A plugin is written with `packages/plugin-sdk`.

## What a plugin is, and isn't

A plugin is a Worker in `plugins/<id>/` that a deployment lists under `plugins` in its registry file.
Fleet tooling binds it to the engine and the web Worker as a service binding named `PLUGIN_<ID>`
(`pluginBinding`: upper case, dashes to underscores, so `qbd-sync` is `PLUGIN_QBD_SYNC`), gives it a
D1 database of its own, and deploys it before the engine. It contributes up to five things, all
optional:

- **Nodes**, namespaced `<id>.<name>`, which the editor offers and the Workflow runs.
- **Providers**: the work behind a built-in node (shipping rates, shipping labels, tax, address
  checks), picked per node in its Provider field ([Providers](#providers)).
- **Event subscriptions** to outbound events, delivered over the binding instead of HTTP.
- **Pages** under `/plugins/<id>/`, served by the plugin and linked from the nav.
- **Public paths** under `/plugins/<id>/` that are forwarded without a signed-in person. They skip the web app's cross-site check too (`isPluginPublicPath`): nothing ambient (cookie, sign-in) reaches the plugin on them, so a partner's site may post to them.
- **Host calls**: with capabilities the deployment grants, it opens external carts for buyers it
  has authenticated and starts orders, through its `ORDERLOOP` binding ([The host API](#the-host-api)).

It is not a way to change the core. A plugin owns its tables (the core's schema and migrations never
mention one), reaches OrderLoop only through `PluginRpc` and, where granted, the host API, and gets no `env` of the engine or web app.
It cannot add a trigger, wait for an event, loop, or change the planner. Nothing in
`packages/core/src/graph.ts` knows a plugin exists except `validateGraph`, which takes a node
registry. A deployment with no `plugins` runs the built-in catalog alone (`staticRegistry`) and adds
no step, binding or check.

## The contract

Every plugin's default entrypoint is a `WorkerEntrypoint` implementing `PluginRpc`. `definePlugin`
(`@orderloop/plugin-sdk`) builds it from a manifest and handlers; the table is what it implements:

| Method | Called | Must |
|---|---|---|
| `manifest()` | By the engine, at most every 60 seconds per isolate (10 seconds allowed to answer), and by deep health | Return a `PluginManifest` that `parseManifest` accepts |
| `execute(req)` | Inside a plugin node's own `step.do`, within `PLUGIN_CALL_MS` (60 seconds) | Do the node's work and return `{ branch?, output?, summary?, vars? }` or `{ fail: { message, retry? } }`; checked by `checkExecResult` (below) |
| `compensate(req)` | When the order fails after a node with `rollback: true`, within `PLUGIN_CALL_MS` | Undo that run; return a one-line description (cut to `PLUGIN_SUMMARY_MAX` characters). May run more than once |
| `deliver(payload)` | From the outbox, for events the manifest lists, within 30 seconds | Record the event; throw to be retried |
| `fetch(request)` | For `/plugins/<id>/*` | Serve the page; verify the principal header and its role unless the path is public |
| `renderReturn(req)` | With `carts:external`, when an external cart it opened is sent back (`PLUGIN_CALL_MS`) | Return `{ fields }`, the form fields the core posts to the cart's `returnUrl`; checked by `checkCartReturn` ([The host API](#the-host-api)) |

A call that outlasts its limit fails with `<what> took longer than <n>s`.

A plugin node's `execute` is retried while the plugin is bound but not answering (see [How the parts connect](#how-the-parts-connect)); `compensate` throws for a node type the plugin no longer has, so an order never reads as rolled back while that node's effect stays.

`checkExecResult` holds an `execute` result to the contract. A result that breaks it fails the node
without a retry, since the same code would answer the same again:

| Result | Rule |
|---|---|
| `branch` | One of the node's `outputs`; default the first. Otherwise `<type> chose “<branch>”, which isn't one of its outputs` |
| `summary` | Cut to `PLUGIN_SUMMARY_MAX` (300) characters, ending in `…`; not refused |
| `output`, `vars` | Each at most `PLUGIN_RESULT_MAX_BYTES` (128 KiB) serialized as JSON |
| `vars` | Merged, as a delta over what the plugin set before, into the order's variables at `vars.plugins.<id>`, so a plugin can't overwrite the flow's variables or another plugin's |
| `{ fail: { message, retry? } }` | Fails the node with `message` (at least 1 character, cut to 300 like a summary). `retry: true` throws an ordinary error, so the step retries as when `execute` throws; otherwise it is a `NonRetryableError` and the order rolls back |

The manifest (`pluginManifestSchema`) has:

| Field | Rule |
|---|---|
| `apiVersion` | Must be `PLUGIN_API_VERSION` (`1`); a manifest for any other version is refused |
| `id` | `PLUGIN_ID_RE` (2 to 31 lowercase letters, digits and dashes, starting with a letter); not `trigger`, `commerce`, `control`, `ai`, `core` or `orderloop`; must match the binding it is reached by |
| `name`, `version` | Non-empty. Change `version` whenever the manifest changes |
| `nodes` | At most 50 `PluginNodeSpec`s: `type` is `<id>.<name>` (name lowercase, digits, underscores); `category` is `commerce`, `control` or `ai`; `label`, `description`, `icon` (a lucide-react name); `fields` (at most 50; the catalog's field kinds, with `jsonSchema` in place of a zod schema); `outputs` (at least one, fixed); optional `rollback` and `retries` (0 to 10, default 3). A type the built-in catalog has is refused |
| `events` | Outbound event names, or `"*"` for all |
| `nav` | `{ label, path, icon }`; each `path` is a plain path under `/plugins/<id>/` (`PLUGIN_PAGE_PATH_RE`: letters, digits and `- _ . ~ /`, no `.` or `..` segment, no query or fragment) |
| `publicPaths` | Exact plain paths (same rule) under `/plugins/<id>/` forwarded with no signed-in person |
| `requires` | Ids of plugins that must also be installed |
| `pageRole` | The least role that may open the plugin's pages and see its nav entries; default `operator` |
| `personalData` | `redact` (default) or `send`: whether `execute` and event delivery carry who the buyer is. `send` takes effect only with the deployment's grant (below) |
| `egress` | Hosts a sandboxed plugin may reach (a name, or `*.` and one), at most 20 ([Runtimes](#runtimes)) |
| `limits` | `{ cpuMs?, subRequests? }` per call for a sandboxed plugin, within `PLUGIN_LIMIT_CAPS` |
| `capabilities` | What it asks the core to do through `ORDERLOOP` (`PLUGIN_CAPABILITIES`: `carts:external`, `orders:start`, `orders:cancel`), each at most once; each takes effect only with the deployment's grant ([The host API](#the-host-api)) |
| `provides` | Surfaces from `PROVIDER_SURFACES` (`shipping.rates`, `shipping.labels`, `tax`, `address`) the plugin can do behind built-in nodes. All but `shipping.rates` need `personalData: 'send'` (`SURFACE_NEEDS_BUYER`) ([Providers](#providers)) |
| `secrets` | Up to 20 `{ name, description?, optional?, inject?, expose? }` (`inject: { host, header, format }`, a host in `egress`: added by the egress gateway, never seen by a sandboxed plugin; `expose`: readable by a sandboxed plugin's code; not both): env names the plugin reads (`PLUGIN_SECRET_NAME_RE`, upper case; not `PLUGIN_KEY`, `PLUGIN_KEY_PREVIOUS` or `DB`), set per deployment ([Secrets](#secrets)) |

A manifest over `PLUGIN_MANIFEST_MAX_BYTES` (64 KiB) serialized is refused.

`pluginStatuses` (engine) reports a `PluginStatus` per `PLUGIN_*` binding: `binding`, `manifest`,
`healthy` and `error`. When a manifest doesn't parse or its `id` doesn't match its binding (for
example mid-deploy, or a blip), the plugin is `healthy: false` and the engine keeps running the last
good manifest it saw from that binding, so its nodes don't read as missing and fail running orders;
with none, `manifest` is `null`. A manifest with `personalData: 'send'` is also refused (`It asks for buyer details…`) unless the deployment grants it; the last good manifest stands in only if it needs no grant or the grant is still there, so withdrawing a grant takes effect at once. When a required plugin is absent the manifest is `null` too and the
`error` is `Needs <ids> installed`. Both are logged (`plugin manifest refused`, `plugin missing
requirements`). A plugin with no manifest reads as `Plugin “<id>” is not installed` on its nodes,
and every other flow keeps running.

`execute` receives `PluginExecRequest`: `type`, `nodeId`, `stepKey`, `orderId`, the node's `config`
with defaults filled in (expressions not yet evaluated), the `order`, `vars` and earlier nodes'
outputs (`nodes`). `compensate` receives the same ids and the `output` that `execute` returned.

With `personalData: 'redact'` the `order` is a `RedactedOrder` that `pluginOrder` builds from an
allowlist, as AI nodes get it (`modelOrder`): lines (with product names), amounts, currency, channel,
fulfilment method and ship-to country, plus `externalId`, `createdAt` and the title with emails and
phone numbers masked. It has no contact, addresses, `meta`, inbound document text or key, or payment
ids. `vars` and `nodes` (`pluginView`) are scrubbed the same way as AI nodes' (contact, names and
addresses removed, emails and phone numbers in free text masked), and so is the `data` of every event
delivered to the plugin. Set `send` only when the plugin needs to know who the buyer is, and the
deployment must grant it ([Installing](#installing)): a manifest can't grant itself buyer details.

## Writing a plugin

Copy `plugins/example/` (a test-only fixture covering every extension point; fleet refuses to
install it) and build on `@orderloop/plugin-sdk`. It has:

- `wrangler.jsonc`: the Worker, `workers_dev` and `preview_urls` off, and a `DB` D1 binding with a
  `migrations_dir`. The fleet renders the name (`orderloop-plugin-<id><suffix>`) and the database
  id, so what the file holds are the base names only. `renderPlugin` accepts only the keys in
  `PLUGIN_CONFIG_KEYS` (`$schema`, `name`, `main`, `compatibility_date`, `compatibility_flags`,
  `workers_dev`, `preview_urls`, `observability`, `upload_source_maps`, `vars`, `d1_databases`) and
  at most one D1 binding, named `DB`. Service bindings, Durable Objects, buckets, queues, routes and
  the rest are refused, since they could reach the engine or another deployment's resources.
- `src/index.ts`: `export default definePlugin<Env>({ manifest, nodes, events, pages })`.
  `definePlugin` returns the `PluginRpc` entrypoint class and checks the definition when the Worker
  loads, so a mistake fails the deploy rather than an order: the manifest must parse
  (`parseManifest`), every manifest node needs a handler in `nodes` (by name: `stamp` for
  `example.stamp`) and every handler a node, a `rollback` node needs `compensate`, `events` handlers
  must be subscribed in the manifest, and a manifest with `nav` or `publicPaths` needs `pages`.
  - A node handler's `execute({ req, env, key, fail })` gets `key`, `<orderId>:<stepKey>`, the one
    key to write by, and `fail(message, { retry? })` to build the failing result. `compensate`
    gets the same `key` and returns a one-line description.
  - An `events` handler is called by event name, and every event the manifest subscribes to (other than `"*"`) needs one: `definePlugin` refuses a subscription without a handler.
  - `pages(request, { env, principal })` is called after the SDK verified the principal header
    (keys `PLUGIN_KEY` and `PLUGIN_KEY_PREVIOUS`, the `PluginEnv` secrets; header `PRINCIPAL_HEADER`,
    bound to the request path) and checked `pageRole`: `401` without a valid principal, `403` below
    the role. The principal has `kind`, `id`, `name`, `role` and `email` but no session id. On a
    `publicPaths` entry it runs with `principal: null`, so authenticate the caller yourself.
  - `manifest()` throws while a declared secret not marked `optional` is missing or empty in env
    (`missingSecrets`), naming the `PLUGIN_<ID>_<NAME>` to set, so the engine leaves the plugin out
    and deep health fails until it is set.
    The page runs no script (see [Limits and hardening](#limits-and-hardening)). Answer with a
    view (`viewResponse`, see [Views](#views)) to have the app draw it in its own shell, or render
    HTML whose links and forms come back to `/plugins/<id>/`.
- `migrations/`: the plugin's own D1 migrations. As with the core's, they must work with the code
  already deployed: add first, drop or rename later.
- `package.json` named `@orderloop/plugin-<id>`, depending on `@orderloop/core` and
  `@orderloop/plugin-sdk` (workspace packages are `plugins/*` and `packages/*`, in
  `pnpm-workspace.yaml`).
- `tests/contract.test.ts` and its own `vitest.config.ts` (see below).

The fixture's `example.stamp` inserts a row keyed by `(order_id, step_key)` with `ON CONFLICT DO
NOTHING` and its `compensate` deletes it; its `order.completed` handler inserts the delivery id the
same way. `example.probe` is test-only: it echoes what it is sent, fails, returns too much or a
branch it lacks, or sets variables, as its `behave` field says, so the engine's tests can check what
it refuses. A real plugin has no use for one.

Then run `pnpm install` to link the new package.

### Views

A page answers with a view (`PluginView`, `packages/core/src/plugin-ui.ts`) instead of HTML, and
the web app draws it inside the app shell with its own components: the nav, page header, sections,
tables, forms and alerts every OrderLoop page has, light and dark, without the plugin sending markup
or styles. `viewResponse(view, init?)` from the SDK sends it as `PLUGIN_VIEW_TYPE`
(`application/vnd.orderloop.view+json`) with `cache-control: no-store`.

```ts
return viewResponse({
  title: 'Partners',
  blocks: [
    { type: 'alert', tone: 'error', text: 'That partner already exists.' },
    {
      type: 'section',
      title: 'Partners',
      blocks: [
        {
          type: 'table',
          columns: [{ key: 'name', label: 'Name' }],
          rows: [{ cells: { name: 'Northwind' }, actions: [
            { type: 'form', action: 'partners/ptn_1/rotate', fields: [], submit: 'Rotate secret' },
          ] }],
        },
      ],
    },
    { type: 'form', action: 'partners', submit: 'Add', fields: [{ name: 'name', label: 'Name' }] },
  ],
}, { status: 400 });
```

- A view has a `title`, an optional `description` and header `actions` (links), and `blocks`: `text`,
  `alert` (tone `info`, a plain note; `success`, `warning` or `error`, drawn in the Ledger status
  colors `ok`, `wait` and `destructive`), `stats`, `table` (cells are text, numbers or `{ text, href?, tone?, mono? }`, and each row
  may carry up to four small `form`s as buttons), `form` (fields `text`, `textarea`, `number`,
  `email`, `url`, `date`, `password`, `select`, `checkbox` or `hidden`, an optional `confirm` asked
  before it is sent, and a `danger` tone), `code` and `list`, grouped by `section`s one level deep.
- Links and form actions are paths on the plugin's own pages, relative to them (`partners`) or
  absolute under `/plugins/<id>/`. A scheme, `//`, a fragment or a `.`/`..` segment (`%2e` too)
  fails the check, and a target that resolves anywhere else is drawn as a link to the plugin's
  first page (`pluginViewHref`).
- Forms are ordinary form posts to the plugin; whatever it answers is the next page, so a post
  that should land somewhere else answers with a redirect, as with HTML pages.
- The web Worker draws a view only for a page request: a GET that accepts `text/html`, or a form
  post a browser navigated with (`sec-fetch-dest: document`, or HTML in `accept` without fetch
  metadata). It reads at most `PLUGIN_VIEW_MAX_BYTES`, declared or streamed, and checks it
  (`checkPluginView`, every field bounded) and renders `routes/plugin-page.tsx` as a GET of the
  same address, passing the view in React Router's load context (`pluginPageContext`), with the
  plugin's status. A view that fails the check is drawn as an error naming the first problem,
  never in part. Any other request (a `fetch`, a non-view answer) gets the plugin's response as it
  is.
- A request for route data under `/plugins/<id>/` (a path ending in `.data`, which React Router
  sends when it navigates without loading a document, as on Back) never reaches the plugin: the
  Worker answers it with a reload of the page as a document, so a plugin's answer can't become
  loader data without the check. A plugin can't serve a path ending in `.data`.
- The app's routes know only `/plugins/<id>/…`, so a view asked for under an alias is a `303` to
  that address; a view's own links and forms already go there. An alias still answers machine
  requests (and HTML pages) itself.
- A view page is for signed-in people: the route requires a session, so a public path answers with
  something other than a view.

### The contract suite

`pluginContract(stub, cases)` (`@orderloop/plugin-sdk/contract`) checks a plugin against what the
engine relies on and can't check at run time, and returns the problems found (empty when there are
none):

```ts
expect(await pluginContract(plugin, { effects, deliveries, principalKey })).toEqual([]);
```

It checks that the manifest parses for this contract version; that each node, run with its config's
field defaults filled in (as the engine does), succeeds and writes at least one effect the
`effects()` probe sees (a `fail` result, or no write, is a problem unless the type is listed in
`noEffects`); that running it twice for the same order and step key gives the same result and no
second effect; that a run with another step key (`contract#2`) writes again, so writes are keyed by
order and step key, not the order alone; that, for a `rollback` node,
compensating twice leaves the effect count it had before `execute`; that delivering the same event
twice records it once; and that the first nav page answers `401` without a signed-in person, `403`
to the role below `pageRole`, and neither to `pageRole` itself. `cases` supplies `effects(orderId)`
(count the plugin's rows for an order), and, as the manifest needs them, `deliveries(payloadId)`,
`principalKey` (the plugin's `PLUGIN_KEY`), plus optional `configs` per node type, `noEffects`
(node types that write nothing, such as `example.probe`), an `order` and a `pagePath`. Run it from the
plugin's own tests in workerd: `plugins/example/vitest.config.ts` is a `cloudflareTest` project with
the plugin's migrations applied in `tests/setup.ts` and a `PLUGIN_KEY`. Every plugin ships one.

`bundlePlugin(entry, { name, d1, bindings })` (`@orderloop/plugin-sdk/testing`, Node only) bundles a
plugin with esbuild into a Miniflare auxiliary Worker for another package's vitest config; the
engine's `plugins` project binds the example this way.

To try a plugin in the app locally, apply its migrations to the dev session's state and name it in
`ORDERLOOP_DEV_PLUGINS` (comma-separated). `apps/web/vite.config.ts` then runs it as one more
auxiliary Worker, bound to the web app and the engine as `PLUGIN_<ID>`, with a `PLUGIN_KEY` derived
from `DEV_PRINCIPAL_KEY` as the fleet derives it (never the principal key itself). Dev grants no
`personalData: 'send'`, so a plugin that asks for it shows as refused:

```bash
pnpm --filter @orderloop/plugin-example exec wrangler d1 migrations apply DB --local \
  --persist-to ../../apps/web/.wrangler/state
ORDERLOOP_DEV_PLUGINS=example pnpm web:dev
```

A plugin's secrets in dev go in `plugins/<id>/.dev.vars` (git-ignored), under their own names
(`PING_TOKEN=…`), which the auxiliary Worker reads next to its `wrangler.jsonc`.

### Idempotency

The engine retries steps and replays Workflows, and the outbox redelivers. A plugin must tolerate
both:

- Key every write in `execute` by `orderId` and `stepKey` together. `stepKey` is unique within the
  order and the same on every retry of that step (the node's effect key, `effectKey(generation, key)`).
- Key every write in `compensate` the same way, and make a second call harmless.
- Key every write in `deliver` by `payload.id`, which is stable across redeliveries.

If the plugin calls an external system, pass that system the same key.

## Providers

A provider is a plugin doing a built-in node's work: the node keeps its contract (its fields,
outputs, events and what it writes), and asks the plugin for the part a real service does. A node
with a Provider field (kind `provider`, `providerField` in `packages/core/src/catalog.ts`) offers
`builtin` and each installed plugin whose manifest `provides` its surface (`NodeRegistry.providers`).
The choice is part of the published flow version, so a replay calls the same provider.

| Surface | Nodes | Ops (`ProvideRequest`) | The plugin returns (`PROVIDE_RESULT_SCHEMAS`) | The engine still |
|---|---|---|---|---|
| `shipping.rates` | `commerce.shipping_rate` | `quote` `{ itemCount, billableKg?, country?, subtotal, currency }` (base currency; `billableKg` only when the node's `basis` is `weight` or `dim_weight`) | `{ options: [{ id, amount, title?, carrier?, minDays?, maxDays? }] }` (at most 50), in the base currency | Checks each option as a live carrier's (`parseCarrierQuote`, ids prefixed with the plugin id), drops any over `PROVIDER_MAX_RATE`, applies the free threshold, converts, picks and totals. A provider that fails or offers nothing falls back to the live carriers, then the static services (`source` `provider`, `live` or `static`), with `providerError` in the output and "(<id> unavailable)" in the summary |
| `shipping.labels` | `commerce.ship`, `commerce.return_label` | `create` `{ kind: 'shipment' \| 'return', carrier, packages: [{ ref, locationId, lines }] }` (only packages with goods; none, no call); `void` `{ labels: [{ ref, id }] }` | `create`: `{ labels: [{ ref, id, tracking, carrier? }] }`, one per package; `id`, `tracking` and `carrier` are plain text (letters, digits, spaces, `. _ : # + -`). No label link: one anyone can fetch would carry the buyer's address to every plugin and webhook that sees the node's output. `void`: `{ summary? }` | Writes the shipment rows (with `provider` and `external_id`, migration `0045`), consumes stock, sets `vars.tracking`, emits `order.shipped`. A label for a package it wasn't asked about is voided at once; a package with no label fails the node for good, after voiding what came back |
| `tax` | `commerce.tax` | `calculate` `{ subtotal, shipping, includeShipping, currency }` (the order's currency, as `computeTotals` works them out from the lines) | `{ amount }` | Fails the node for good over `PROVIDER_MAX_TAX_RATE` (50%) of what is taxable, or for tax on nothing taxable; otherwise stores the rate the amount works out to (`amount ÷ taxable`), so nodes that total the order again keep the same tax |
| `address` | `commerce.address_validate` | `validate` `{ address }` (`meta.shipTo`) | `{ status: 'valid' \| 'corrected' \| 'invalid', address, issues }`; `address` has `ShipAddress`'s keys only (so redaction, which goes by key, knows each field), and is required when `corrected`; at most 5 issues | Takes the branch and sets `vars.suggestedAddress` when corrected |

- `provide` (`apps/engine/src/providers.ts`) calls `PluginRpc.provide` inside the node's step, with
  the node's step key, the order as `personalData` allows (`pluginOrder`; `void` carries no order),
  held to `PLUGIN_CALL_MS`, and checks the result with `checkProvideResult`. A provider that isn't
  bound, doesn't provide the surface or returns a result the contract doesn't allow fails the node
  with a `NonRetryableError`; one that is bound but not answering, or returns `fail` with `retry`,
  throws an ordinary error, so the step retries.
- Rates and tax also run while pricing a UCP checkout (`ucp/quote.ts` calls the same executors with
  step key `quote#<nodeId>`, each provider call held to 10 seconds), so `quote`, `calculate` and
  `validate` must write nothing; the contract suite checks it. A provider's failure there (errors
  `provide` throws are tagged, `providerOfError`) becomes the issue "Shipping or tax could not be
  calculated right now.": its own text never reaches the buyer's agent.
- Labels are undone where they were made. The `commerce.ship` rollback (`ROLLBACKS`, which now get
  the step key) calls `void` for its shipments that have a `provider` before cancelling the rest
  (`voidShipmentLabels`). Cancelling an order (`compensateOrder`) voids its open provider labels
  first, return labels included (`voidOpenLabels`, step key `cancel`). Either way a label the
  provider can't void is kept as a `void_failed` shipment, never `cancelled`, and counted in the
  timeline; the rollback doesn't fail for it, so the saga's earlier compensations (the payment
  void, the stock release) still run. The engine's daily cron tries those again
  (`retryLabelVoids`, step key `retry`), and `pluginUsage` lists them under `labels`, so the
  plugin can't be removed while it holds one. `void` is keyed by the label ids it is sent: it may
  run again.
- A Worker rollback to a version from before providers ignores a node's Provider (built-in tax and
  mock labels) and cancels provider shipments without voiding them; roll forward instead.
- A flow that names a provider depends on that plugin: `nodePlugins`/`flowPlugins` count it, so the
  run gets a `load-plugins` step, `pluginUsage` (and `plugin:check`) report the flow, and
  `validateGraph` refuses it (`Provider: plugin “<id>” is not installed` or `doesn't provide …`)
  once the plugin is gone or no longer provides the surface.
- With the SDK, `definePlugin({ providers: { 'shipping.labels': { create, void }, … } })`: every op of
  every surface in `provides` needs a handler, and none for a surface it doesn't list. Each gets
  `req`, `env`, `key` (`<orderId>:<stepKey>`) and `fail`. `plugins/fixture-carrier` is the template
  (and a test fixture no deployment may install).

Payments and inventory have no provider surface: payments are bound to Stripe holds, UCP adoption,
refunds across payments and webhooks, and stock is the core's. A plugin adds those as its own nodes.

## Installing

1. Add the plugin to the deployment's registry file, `deployments/<id>.jsonc`:
   `"plugins": { "qbd-sync": {} }`. `loadDeployments` refuses an id that isn't a plugin id, one that is a
   fixture (`example`, `fixture-carrier`), and one without `plugins/<id>/wrangler.jsonc`. An entry holds `d1Id`,
   `personalData`, `runtime` (`worker` or `sandboxed`, see [Runtimes](#runtimes)) and `secrets`, and no other key. A deployment on its own Cloudflare account also sets `secretsStore: { storeId }` at the top level ([Secrets](#secrets)).
   **Granting buyer details**: a plugin whose manifest says `personalData: 'send'` is refused (its
   status is `healthy: false` with `error` `It asks for buyer details…`) unless its entry says
   `"personalData": "send"`: `"plugins": { "qbd-sync": { "personalData": "send" } }`. Only that value
   is accepted. `renderEngine` writes the grants into the engine's `PLUGIN_GRANTS` variable
   (`{"qbd-sync":{"personalData":"send"}}`), which the engine reads on every status check. Removing
   the grant refuses the plugin on the next deploy, even if its last good manifest asked for `send`.
   Grant it only after reviewing what the plugin does with buyer details.
   **Granting capabilities**: a plugin whose manifest lists `capabilities` is refused (`It asks to
   <capabilities>, which this deployment does not grant`) unless its entry lists them:
   `"plugins": { "punchout": { "capabilities": ["carts:external", "orders:start", "orders:cancel"] } }`. They go into
   `PLUGIN_GRANTS` beside `personalData`, and give a Worker plugin its `ORDERLOOP` binding
   ([The host API](#the-host-api)). A runtime install never gets a capability (one whose manifest
   asks for any is refused at upload, [Installing at runtime](#installing-at-runtime)). `orders:cancel` is
   granted apart from `orders:start`, so a plugin trusted to place orders can't also call them off
   unless the deployment says so. Since a manifest asking for an ungranted capability refuses the
   whole plugin, a plugin that adds one ships with its grant: a sandboxed plugin's pinned bundle
   (and so its manifest), `PLUGIN_GRANTS` and the check are all in the same engine version, so the
   deploy (and a rollback) moves them together. A `worker` plugin deploys just before the engine,
   so until the engine with the grant is out it runs on its last good manifest (or, in an isolate
   without one, is refused).
2. Run `./scripts/provision.sh <deployment>`. For each `worker` plugin it creates the D1 database
   `orderloop-plugin-<id><suffix>` and records its id with `fleet.ts set-plugin-d1`, as `plugins.<id>.d1Id`.
   A deployment with a plugin lacking `d1Id` fails `fleet.ts matrix` (CI's plan) unless it is held.
   A sandboxed plugin needs nothing created; with a `secretsStore` it checks the store exists.
3. Merge. CI's deploy job (`.github/workflows/deploy.yml`) renders `plugins/<id>/wrangler.<deployment>.json`,
   writes one secrets file per plugin (`fleet.ts secrets plugin <out> <plugin>`), holding that
   plugin's own `PLUGIN_KEY`, during a rotation `PLUGIN_KEY_PREVIOUS`, and its own secrets
   ([Secrets](#secrets)); then in the **Deploy
   plugins** step applies each plugin's D1 migrations and deploys its Worker with its file, all
   before the engine, because the engine and web Worker bind
   to it. The engine's and web Worker's configs gain a service binding per `worker` plugin. A
   sandboxed plugin has no Worker: **Publish sandboxed plugins** puts its bundle in `DOCS` and pins
   its sha in the engine's `PLUGIN_BUNDLES` ([Runtimes](#runtimes)).

A plugin never holds `PRINCIPAL_KEY`. `pluginKey(principalKey, id)` (`packages/core/src/plugins.ts`,
mirrored by `scripts/fleet.ts`; `scripts/fleet.test.ts` holds both to the same vector) is the
hex HMAC-SHA256 of the principal key over `orderloop-plugin:<id>`. The web Worker signs a plugin's
page requests with it, so the engine and every other plugin, which hold other keys, refuse a
principal signed for this one, and a plugin can't sign requests to them. Rotating `PRINCIPAL_KEY`
([Operations](operations.md#rotating-the-principal-key)) rotates every plugin's key too, with
`PLUGIN_KEY_PREVIOUS` covering the gap.

### Secrets

A plugin that calls another service declares the secrets it reads in its manifest's `secrets`, and
reads them with `secret(env, name)` from `@orderloop/plugin-sdk` (never `env.NAME`), which finds
them wherever its runtime and the deployment's account keep them. Each secret is named
`PLUGIN_<ID>_<NAME>` for the deployment (`pluginSecretVar`): `API_KEY` of `shipstation` is
`PLUGIN_SHIPSTATION_API_KEY`. Where the deployment keeps the values depends on its Cloudflare
account:

| | Shared account (no `secretsStore`) | Own account (`"secretsStore": { "storeId": "…" }`) |
|---|---|---|
| Where values live | The deployment's GitHub environment (`deploy-<id>`) | The account's Cloudflare Secrets Store (one store an account, 100 secrets) |
| Worker plugin | Written to its Worker's secrets by the deploy (`pluginOwnSecrets`, under `<NAME>`) | Bound from the store under `<NAME>` (`renderPlugin` adds `secrets_store_secrets`) |
| Sandboxed plugin | Written to the engine as `PLUGIN_SECRETS` (`fleet.ts secrets sandboxed`) | Bound to the engine as `PLUGIN_SECRET_<ID>__<NAME>` (`storeBinding`) |
| Registry | Nothing to list | List the names in `plugins.<id>.secrets` (Secrets Store bindings are per secret) |
| Rotating | Change it in the environment and redeploy | Change it in the store: read on the next call, no redeploy |
| Revoking | `--secrets-file` never removes: rotate it at its issuer | Delete or rotate it in the store |

- The deploy's **Collect plugin secrets** step (only with plugins installed) reads the environment's
  secrets (`toJSON(secrets)`, as `ENV_SECRETS`); each plugin gets only those with its own prefix,
  never another plugin's nor the core's. A `PLUGIN_<ID>_` secret whose name isn't a secret name, or
  is reserved (`PLUGIN_KEY`, `PLUGIN_KEY_PREVIOUS`, `DB`, `SECRETS`, `STORAGE`), fails the deploy.
- **Check plugin secrets** runs before anything deploys: each plugin's manifest, as the
  `plugin-bundles` job read it from its `src/manifest.ts` (`readManifest`, by
  `scripts/plugin-bundle.ts`, in a job with no environment, no secrets and no Cloudflare token,
  since reading a manifest runs the plugin's code), and every secret it needs
  (not `optional`) must be set: in the environment, or listed in the registry and present in the
  store (`missingPluginSecrets`, by name only, through the Secrets Store API). The CI token then
  needs Account Secrets Store Edit (also needed to deploy a Worker that binds the store).
- A required secret missing at run time (removed from the store, say) fails the plugin's
  `manifest()` (`missingSecrets`), so it reads as not installed and deep health names the secret.
- Two installed plugins whose ids would share a prefix (`ship` and `ship-rates`:
  `PLUGIN_SHIP_RATES_X` is both `ship`'s `RATES_X` and `ship-rates`'s `X`) are refused by
  `loadDeployments`. Ids have no `--`, so a binding name never holds `__` and a Secrets Store
  binding is never taken for a plugin.
- Secret values never reach the web app. The Plugins page shows each declared secret's name, how
  it reaches the plugin (injected for a host, or readable by the plugin) and its description, never
  its value.

## The host API

A plugin asks the core for anything only through `ORDERLOOP`, typed `PluginHostRpc`
(`packages/core/src/plugin-host.ts`) and served by the engine's `PluginHost` entrypoint
(`apps/engine/src/plugin-api.ts`); `host(env)` in the SDK returns it. Who is calling is the
binding's own `props.id`, never an argument: fleet rendering gives a Worker plugin a service binding
to `PluginHost` with `props: { id }` (only when its registry entry grants a capability), and the
sandbox loader gives a sandboxed one `ctx.exports.PluginHost({ props: { id } })` on the same
condition. Every call checks, at that moment, that the registry installs the plugin (`registryOwns`),
its manifest declares the capability and the registry grants it (`mayUse`), so withdrawing a grant
takes effect at once and a runtime install of the same id never inherits it.

| Method | Needs | Does |
|---|---|---|
| `openExternalCart(input)` | `carts:external` | Opens a [cart](architecture.md#carts) for a buyer the plugin has authenticated (`ExternalCartInput`: `sessionRef`, `title`, `flowId`, `customerId`, `buyer`, an https `returnUrl`, https `frameOrigins`, `expiresAt` within 24 hours, optional starting `lines`), checked by `externalCartProblem` (types too, and a `returnUrl` on none of the deployment's `OWN_HOSTS`) and like a staff cart (a flow that prices, an existing customer). The same `sessionRef` finds the same cart (unique `(plugin_id, session_ref)` in `carts`). Answers the cart id, a one-time `startPath` (`/cart/start/<cartId>/<token>`, `CART_START_TTL_MS`, 5 minutes) and the same as `startUrl` on `APP_ORIGIN`; a session whose cart has ended or expired is refused |
| `getCart(cartId)` | `carts:external` | The cart as `PluginCart`, or null for one another plugin (or a person) opened |
| `cancelOrder({ key, reason })` | `orders:cancel` | Cancels an order this plugin started, found by the key it started it under (`plugin:<id>:<key>`; another plugin's never matches): `cancelled` (also when it already was, or another cancel of it is under way) or `finished` when it ended some other way, audited as `order.cancelled` by `plugin:<id>` |
| `startOrder({ key, flowId, input })` | `orders:start` | Starts an order once per key, under the idempotency key `plugin:<id>:<key>` (`pluginOrderKey`), `startedBy` `plugin:<id>` and `meta.plugin` set by the host (and `meta.ucp` and `meta.cart` dropped: the core's to set); the input is checked by `startOrderSchema` and its currency must have an exchange rate, as on the REST API; a new order is audited as `order.started` by `plugin:<id>`. The REST API refuses Idempotency-Keys in any namespace the core starts orders under (`RESERVED_ORDER_KEY_PREFIXES`: `cart:`, `ucp:`, `plugin:`, `order:`, `email:`, `a2a:`, `replenish:`). A replay answers the same order with `replayed: true`; the same key with a different request is refused |

`plugins/punchout` is the plugin that uses it: cXML and OCI punchout, installed with
`"plugins": { "punchout": { "capabilities": ["carts:external", "orders:start", "orders:cancel"] } }` (and its `d1Id`, or
`"runtime": "sandboxed"`). Its partners and their secret hashes are in its own database; see the
[Punchout guide](https://docs.orderloop.app/guides/punchout/). Each version of a PO it acted on is a
`purchase_orders` row, numbered per partner and orderID. A change claims the next version (a unique
`(partner_id, order_ref, version)`) before it acts, so of two changes sent at once only one acts on
the version before and the other is told to send again (cXML `409`). An `update` starts the changed
order before it cancels the one it replaces (and withdraws the new one when that can't be
cancelled), so a change the core refuses leaves the PO's order running; a claim whose action failed
is deleted, and one that stopped part way is finished by its own resend. A PO whose latest version
is a `delete` stays cancelled: a later `new` or `update` of it is `409`.

When an external cart's buyer sends it back (`CartAgent.transferAs`; only the buyer, since the fields are posted from the browser that asked), the core
holds the cart, calls the plugin's `renderReturn({ cart })`, checks the answer (`checkCartReturn`:
string fields only, at most 2,000 and 1 MiB) and keeps it, marks the cart `returned`, and posts the
fields to the cart's `returnUrl`. The plugin never chooses where they go.

## Aliases

A deployment can give a plugin a second address, so its public URLs read better than
`/plugins/<id>/`: `"plugins": { "punchout": { "alias": "/punchout/" } }` answers
`/punchout/cxml/setup` as `/plugins/punchout/cxml/setup`. The registry chooses it, never the plugin
(a manifest's paths stay under `/plugins/<id>/`), and fleet refuses one that isn't a single
lowercase segment, is one of the app's own top-level paths (`RESERVED_PATH_SEGMENTS`), or is
another plugin's. `renderWeb` writes the map into the web Worker's `PLUGIN_ALIASES` (always, empty
when there are none).

The web Worker checks aliases last, after every path it serves itself (`unalias` in
`apps/web/app/lib/plugins.server.ts`), rewrites the path to the plugin's own and forwards it through
`pluginFetch` like any plugin request: the same sign-in, page role, public paths, rate limits,
allowed headers, CSP and redirect rules, and the principal is signed for the `/plugins/<id>/` path.
The plugin is told its alias in the `x-orderloop-alias` header (set by the web Worker only), so a
page can show the shorter address; its own paths keep working.

## Runtimes

A deployment runs each plugin one of two ways, set by `plugins.<id>.runtime` in its registry:

- **`worker`** (the default): its own Worker and D1 database, bound to the engine and the web
  Worker as `PLUGIN_<ID>`, as above. Trusted as code in this repo is.
- **`sandboxed`**: a Dynamic Worker the engine loads itself (Worker Loader, `LOADER`; open beta, on
  Workers Paid). It has no Worker, binding or D1 of its own, and the same source runs either way.

A sandboxed plugin, in `apps/engine/src/plugin-host.ts`:

- **Bundle and pin.** CI's `plugin-bundles` job (no secrets) builds it (`scripts/plugin-bundle.ts`:
  its code as one module, its migrations, and its manifest from `src/manifest.ts`); the deploy job
  checks the hash again, publishes it to the deployment's `DOCS` bucket (in its jurisdiction) as
  `plugins/<id>/<sha>.json`, and pins the shas in the engine's `PLUGIN_BUNDLES` (**Publish
  sandboxed plugins**, before the engine deploys). The engine loads a bundle only if it hashes to
  its pin, before Worker Loader runs it. Bundles are never removed, so rolling the engine back
  restores the old pins.
- **Its pinned manifest is its rules.** Egress, `inject` and `expose`, and limits are enforced from
  the manifest sealed in the bundle (`pinnedManifest`), never from what its code answers with; a
  plugin whose `manifest()` answers otherwise is refused (`pluginStatuses`: "differs from the one
  pinned"). The Plugins page and the editor still show the answered manifest, which then matches.
- **Its env is capabilities only**: `STORAGE` (`PluginDb`, SQL against its own `PluginStorage`
  SQLite Durable Object; `pluginDb(env)` in the SDK gives it D1's `prepare().bind().first/all/run`
  and `batch`), `SECRETS` (`PluginSecrets`: `has` for any declared secret, `get` only for one marked
  `expose`), `ORDERLOOP` (`PluginHost`, only with a granted capability), and `PLUGIN_KEY` (derived from `PRINCIPAL_KEY` as a Worker plugin's is). The bundle's
  migrations are applied to its storage once each, forward only, each file whole, with no other
  request let in meanwhile. Its storage is in the deployment's jurisdiction (`pluginStorage`), and
  only `query` and `batch` answer over RPC (the rest is JS-private).
- **Egress** (`globalOutbound` is `PluginEgress`): https only, to a public host in its manifest's
  `egress` (a name, or `*.` and one); never a private, loopback, link-local, CGNAT, multicast or
  metadata address, an internal name or a wildcard-DNS service (`egressRefusal`, whatever `egress`
  says), nor a URL with credentials. Redirects are followed by the gateway, at most 5, each
  checked again; when one leaves the origin, `authorization`, `cookie` and `proxy-authorization`
  are dropped. A secret declared `inject: { host, header, format }` (an exact host, never `*.`) is
  added for that host as `header` (`format` with `{}` for the value) and stripped from anything
  else, so the plugin never sees it. A request body over 10 MiB is refused with `413`. A refusal is
  a `403` the plugin sees, and a log line naming the plugin, the origin and path (no query).
- **Limits per call** (`limitsFor`): the manifest's `limits`, within `PLUGIN_LIMIT_CAPS`: 200 ms of
  CPU and 20 subrequests for a node, provider op or compensation; 1,000 ms for a page or delivery.
  Local workerd doesn't enforce them; Cloudflare does.
- **Logs** (`tails` is `PluginTail`): its console goes to the engine's logs tagged with the plugin,
  and its exceptions to `plugin_errors` (migration `0046`, the latest 100 per plugin), shown on the
  Plugins page; both scrubbed of its secrets first.
- **Scrubbing.** Text a plugin returns (a `fail` message, a summary, a compensation's line, an error
  it throws, a provider's failure, its manifest error) passes `scrubCredentials`
  (`packages/core/src/credentials.ts`) with its own secrets' values: those values exactly, then
  anything shaped like a credential (prefixed keys, private keys, JWTs, URL credentials,
  `secret=…` pairs, long random runs). Its data (a node's `output` and `vars`, a provider's answer)
  has its secrets' exact values replaced (`scrubbedValue`), so an upstream that echoes a request
  can't land one in an order. Both apply to Worker plugins too.
- **Pages** go through the engine: the web app builds the request as for any plugin (signed
  principal, allowlisted headers, its CSP on the response) and calls `EngineRpc.pluginFetch`.
- **Deliveries** to sandboxed plugins, and their manifest checks, run one at a time (Worker Loader
  limits how many Dynamic Workers a request has in flight).

Write a plugin for either runtime the same way: `definePlugin`, `pluginDb(env)` for its database,
`secret(env, name)` for secrets, and its manifest in `src/manifest.ts` (no Worker imports) for CI
to read. In dev, `ORDERLOOP_DEV_PLUGINS=<id>:sandboxed pnpm web:dev` runs it sandboxed (the
bundle is built at startup and handed to the engine as `PLUGIN_DEV_BUNDLES`, checked like any).

A plugin's first deploy has no earlier version to roll back to; a failed deploy rolls back the plugins
that did deploy, with the rest.

Within a minute per isolate the plugin's nodes appear in the editor palette and its `nav` entries in
the shell (for people at or above its `pageRole`). Admins see what is installed at **Plugins**
(`/plugins`, in the account menu), and `GET /api/v1/plugins` lists it.

## Installing at runtime

A deployment's admin can install a **sandboxed** plugin from the Plugins page, with no registry
change and no deploy, if it is signed by a publisher the deployment trusts. The registry still
decides who that is.

**Publishers.** `pluginInstalls.publishers` in `deployments/<id>.jsonc` names each trusted
publisher's Ed25519 public key (base64url, the raw 32 bytes):
`"pluginInstalls": { "publishers": { "orderloop": "…43 characters…" } }`. `renderEngine` writes it
to the engine's `PLUGIN_PUBLISHERS`. A deployment without it has runtime installs off: an upload is
refused with `Runtime installs are off for this deployment`. Adding or rotating a key is a reviewed
registry change ([Operations](operations.md#plugin-publishers)).

**Packing and signing** (`scripts/plugin-pack.ts`, Node only, never near a deployment's secrets):

```bash
pnpm plugin:pack keygen acme acme.pem            # once: the private key stays with the publisher
pnpm plugin:pack pack plugins/acme-carrier acme-carrier.olplugin --publisher acme --key acme.pem
```

`pack` builds the bundle as CI does (`buildSandboxBundle`) and writes a `.olplugin`: JSON
`{ format: 1, id, version, sha, body, publisher, signature }` (`pluginBundleFileSchema`), where `body`
is the bundle (`{ code, migrations, manifest }`), `sha` its SHA-256, and `signature` the Ed25519
signature over `orderloop-plugin:1:<id>:<version>:<sha>` (`bundleSigningMessage`). At most 5 MiB
(`PLUGIN_BUNDLE_MAX_BYTES`).

**Uploading** (`uploadPlugin`, `apps/engine/src/plugin-installs.ts`) refuses, with a reason the page
shows as it is: a file that isn't a bundle; a publisher not listed; a signature that isn't that
publisher's; a `sha` that isn't the body's; a manifest whose id or version differs from what was
signed; a manifest that declares `capabilities` (only the registry grants one, so it could never
load: refused naming them, before the manifest is parsed or anything is stored, so a capability this
engine doesn't know is named too and a rolled-back engine never meets one in a stored manifest;
`stageBundle` checks an assistant draft the same way, and `approvePlugin` refuses a stored version
that declares any); an id the deployment installs through its registry (registry plugins always win); an
upgrade signed by another publisher than the installed one; a test fixture's id (`example`,
`fixture-carrier`; the installs tests set `PLUGIN_TEST_FIXTURES`); malformed migrations; a version
already uploaded (uploading a pending one again answers with its review, so a retry is safe); and a bundle
whose code, loaded with no network and no capabilities (a dry run), answers with another manifest
than the one sealed in it. A bundle that passes is stored in `DOCS` at `plugins/<id>/<sha>.json` and
recorded `pending` in `installed_plugins`. It doesn't run: its nodes read as not installed. An id's
first install (or its first since an uninstall) wipes the id's storage first, so it never reads what
a removed registry plugin or an earlier install of that id left.

**Review and approve.** The page shows what the pending upload adds and reaches (its nodes, events,
pages, egress hosts, secrets and whether it asks for buyer details), signed by whom. Its secrets can
be set before it runs. **Approve** (`approvePlugin`) needs every required secret set and, for a
plugin that asks for buyer details, the admin's grant (a checkbox, off by default); the grant is
stored on the row (`personal_data_granted`) and is the plugin's grant, as `PLUGIN_GRANTS` is for a
registry plugin. The version that ran before is `superseded`. Approving, rolling back, turning on,
uninstalling, and setting a secret of a plugin that runs each need a **step-up** (`stepUp`, `apps/web/app/lib/auth.server.ts`): a current
two-factor code from someone with two-factor sign-in, otherwise their password, otherwise (single
sign-on only) signing in again at the identity provider on this session within the last ten minutes
(`/login/sso?reauth=1` sends `prompt=login` and `max_age=0`, the callback needs the ID token's
`auth_time` after the flow began and the identity linked to them, and `recordReauth` stamps
`sessions.reauth_at`; a new session alone doesn't count); wrong answers are throttled. Each state change
guards on the status it read (`activate`, `setPluginEnabled`), so two admins acting at once get
`changed while you were looking` rather than two running versions, and the unique index
`installed_plugins_running` (one `active` or `disabled` row per id) is the backstop. A version whose
publisher is no longer in `PLUGIN_PUBLISHERS` can't be approved, rolled back to or turned on. A
plugin's pages can only post forms to its own `/plugins/<id>/` (`form-action`), never to the page
that installs plugins. The REST API can
upload (`POST /api/v1/plugins`) and turn one off (`POST /api/v1/plugins/{id}/disable`), never
approve.

**Running.** The engine merges the active rows into its pins (`bundles`, cached 15 seconds per
isolate, dropped by an install call in the same isolate) after `PLUGIN_BUNDLES`, so a runtime
install runs exactly as a registry one: the bundle hashed against its pin, its sealed manifest
enforced. Its status has `source: 'installed'`.

**Secrets.** An admin enters each declared secret on the page (`setPluginSecret`): at most 4096
characters, sealed with `DATA_KEY` into `plugin_secrets` (context `plugin_secrets:<id>:<name>`),
never shown again, only "set" or "not set", and resealed by the key rotation sweep. `resolveSecret`
reads the Secrets Store binding first, then `PLUGIN_SECRETS`, then `plugin_secrets`, which (like an
install's buyer-details grant) never applies to a registry plugin of the same id (`registryOwns`).

**Afterwards.** Turn it off and on (`setPluginEnabled`: off, it drops out of the pins and its nodes
read as not installed); roll back to any `superseded` version (`rollbackPlugin`; its bundle is still
in `DOCS`); uninstall (`uninstallPlugin`), refused while `pluginUsage` lists a published flow, a
running order or a label not yet voided, which then wipes its storage, marks its rows `uninstalled`
(kept, for the record) and deletes its secrets; the wipe goes first, so a failure can be retried.
Other isolates may still run it for their cache's 15 seconds. A rollback runs the older code
against the storage as the newer version's migrations left it (migrations only go forward). Every action, and every refusal, is in the audit
log (`plugin.*`).

## Assistant-drafted plugins

With `pluginInstalls.assistant: true` in the registry (the engine's `ASSISTANT_PLUGINS=on`), an
admin can ask the assistant for a business rule ("hold orders over $5,000 shipping outside the
US") and it drafts a plugin of rule steps (`draft_plugin`, `apps/engine/src/assistant/plugin-draft.ts`).
Nothing it writes runs until an admin approves it on the Plugins page, with a step-up, like any
upload.

**What the model writes.** Only JSON (`runJson` with `ASSISTANT_MODEL`, prompt `plugin_draft@1`):
a name, steps (snake_case name, label, outputs, and number, string or boolean settings with
defaults), the rule code, and test cases. The code defines `const rules = { <step>: ({ order,
config, vars }) => ({ branch, summary?, vars? }) }` over a `RedactedOrder`. In mock mode only,
`heuristicDraft` writes one threshold rule from "over <amount>"; a failed model call is refused, never
replaced by a stock rule. A new request gets an id of its own (`ai-<slug>`, then `-2`, `-3`); only
`pluginId` revises.

**What the engine writes**, so the guardrails don't depend on review:
- the manifest (`draftManifest`): id `ai-<slug>`, version one more than the id's rows, steps
  `ai-<slug>.<name>` in category `commerce` with no rollback or retries, `personalData: 'redact'`,
  and no `egress`, `secrets`, `events`, `nav`, `publicPaths` or `provides`; limits 50 ms of CPU and
  no subrequests. Whatever else the model returns is ignored.
- the module (`hostModule`): a fixed host around the rule code, which runs inside a function scope.
  `manifest()` answers from a string constant, `execute` runs the step's rule and turns a throw into
  a failed step, `compensate` has nothing to undo, and `fetch`, `deliver` and `provide` refuse, as
  the host's own methods, so nothing a rule adds to a prototype answers in their place. A rule that
  rewrites the globals the host uses only changes what `manifest()` answers, which the pinned
  manifest overrides. The engine serves pages only for a plugin whose pinned manifest has `nav` or
  `publicPaths` (`pluginFetch`). No SDK and no
  imports: the bundle is a few KB. The bundle keeps the rule code as `rules`, for the review.
- refusals (`draftProblem`): no steps or more than 10, a bad step, output or setting name, repeated
  outputs, code over 16 KiB, code without `const rules =`, an escape (`\u`, `\x`) outside a string,
  and code naming what a rule never needs (`import`, `export`, `require`, `eval`, `Function`,
  `fetch`, `globalThis`, `WebAssembly`, `caches`, `XMLHttpRequest`, `WebSocket`, the host's names,
  `__proto__`, `constructor`, `prototype`, `defineProperty`, `setPrototypeOf`, `Reflect`, `Proxy`,
  `process`), read with comments and string text removed (`codeOnly`). That list is a heuristic:
  the sandbox is the boundary, with no network (`globalOutbound: null`), no storage, no secrets and
  a CPU cap. A refused draft is audited `plugin.draft_refused`, with its reason and request.

**Cases** (`apps/engine/src/plugin-cases.ts`): each names a step, an order (any field left out comes
from `sampleRedactedOrder`, a one-line US order of 100 USD, with a fresh id, title and date each run
so a rule can't tell a case from an order by them), settings (defaults filled) and the branch (and
variables, compared whatever their key order) it must give. `runCases` runs each in a bare sandbox
as the engine would run the step, with the draft's own CPU limit, through `checkExecResult`. The results are kept on the row (`installed_plugins.cases`);
the admin edits and re-runs them on the Plugins page (`runPluginCases`, only while the draft is
pending; a write guards on the cases it read, so a concurrent edit isn't lost). Approving re-runs
them on the stored bundle and is refused unless every step has a case and all pass. Cases show
behaviour, not safety: the review says to read the code. Local workerd doesn't enforce the CPU cap, so a rule that loops is only stopped deployed.

**Trust.** A draft is staged by `stageBundle`, the second half of an upload, under the publisher
`assistant`, which no registry key may use (`fleet.ts` refuses it, and an uploaded file claiming it
is refused). It is trusted only while `ASSISTANT_PLUGINS` is on: turning it off stops every drafted
plugin running (`activeInstalls` drops them) and refuses approving, rolling back to or turning on
any. A version names one bundle ever (`installed_plugins_version`), so two drafts at once can't both
be version 3. Over MCP, `draft_plugin` is not read-only (it saves a draft). A draft revises only an
`ai-*` plugin the assistant drafted (`pluginId`), as its next version. Each draft is audited
`plugin.drafted`, and each run of its cases `plugin.cases_run`.

## The Plugins page

`apps/web/app/routes/plugins.tsx` is an admin-only page. For each installed plugin
(`EngineRpc.pluginCatalog`, a `PluginStatus` with its `id` and `runtime`) it shows whether the plugin
is answering, refused, or not answering while running its last manifest, with the `error`; its
contract version, how it runs (as its own Worker, or sandboxed in the engine, with the hosts its
`egress` allows), its core access (the `capabilities` it was granted, in words from
`PLUGIN_CAPABILITY_LABELS`, or None: a loaded plugin's manifest asks only for what the registry
grants), whether buyer details are redacted or sent, who may open its pages and its public
paths, its events, what it `provides` behind built-in nodes, what it `requires`, its secrets (name,
description and how each reaches the plugin: added to requests to a host, or readable by the plugin;
never a value), and its nodes with their category, outputs and whether they roll back. For a plugin
with a manifest it adds what uses it (`pluginUsage`: published flows, the number of orders not yet
ended, and labels it couldn't void) and, for one with events or earlier deliveries, its ten most
recent deliveries (subscription `plugin:<id>`) with status, attempts and last error. A sandboxed
plugin with exceptions also lists its ten most recent (`plugin_errors`, newest first). A refused
plugin has no manifest but still has an id, and the page shows the same usage and deliveries, when
its flows and orders matter most. A registry plugin is read-only there: installing and removing one
is a change to the deployment. The page also uploads, reviews and approves runtime installs, and for
each one sets its secrets, turns it off and on, rolls it back and uninstalls it
([Installing at runtime](#installing-at-runtime)).

## Removing

A published flow or a running order that uses a removed plugin's nodes fails, so check first.

1. Run `ORDERLOOP_API_TOKEN=ol_… pnpm plugin:check <deployment> <plugin>` (`scripts/plugin-check.ts`),
   with an admin's API token. It calls `GET /api/v1/plugins/<plugin>/usage` on the deployment and
   prints each published flow (`pluginUsage`: the published version, not archived) and each order not
   yet ended whose flow version uses the plugin's nodes (a `failed` order counts until it is rolled
   back, since its compensations still call the plugin) and each label it made but couldn't void
   yet (`void_failed`, retried daily), and exits `1` if there are any.
   Republish those flows without the nodes, and let the orders finish or cancel them.
2. Remove the plugin from `plugins` in the registry file and merge. CI stops deploying it, and the
   engine and web Worker lose the binding.
3. Delete the plugin's Worker (`orderloop-plugin-<id><suffix>`), its D1 database (the same name, after
   exporting whatever the contract requires) and `plugins/<id>/`.

Do step 2 before step 3: deleting a Worker that a deployed Worker still binds fails the next deploy.
If a flow still uses the plugin after removal, `validateGraph` reports `Plugin “<id>” is not
installed` on its nodes (it can't be published), an order reaching a node fails it without retries
(`NonRetryableError`), and the rollback of earlier steps runs. A compensation for a plugin node
throws when the plugin is gone, since there is nothing to undo it with.

## Limits and hardening

- No trigger, waiting or looping nodes: `category` is `commerce`, `control` or `ai`, and a plugin
  node runs in one step and picks a branch from fixed `outputs`.
- A node's `icon` outside the app's set (`apps/web/app/components/node-icon.tsx`) shows as a puzzle piece.
- A call into a plugin is bounded (`PLUGIN_CALL_MS`, 60 seconds for `execute` and `compensate`; 30
  for `deliver`; 10 for `manifest`), and a result is bounded (see the contract). The engine hands a
  plugin buyer details only with `personalData: 'send'` and the deployment's grant.
- A manifest is at most `PLUGIN_MANIFEST_MAX_BYTES` (64 KiB), with at most 50 nodes and 50 fields a
  node; nav and public paths are plain paths.
- Manifests are cached about 60 seconds per isolate, in the engine (`MANIFEST_TTL_MS`, one cache
  per `env`) and in the web app, so a redeployed plugin's nodes and pages show up after that. A
  status with any plugin unhealthy is cached only 5 seconds (`UNHEALTHY_TTL_MS`), so one that
  didn't answer is asked again soon. Deep health reads fresh, but at most every 10 seconds
  (`FRESH_MIN_MS`), since `/health/deep` is a public route. A flow with plugin nodes reads the
  manifests once in a durable `load-plugins` step so a replay sees the same specs; flows without
  them add no step.
- A plugin's pages load as whole documents (`reloadDocument`), not as app routes, and it can't
  import app code. A view is drawn by the app's own route from data the plugin sent; nothing in it
  is markup, and its links and forms are plain document requests back to the plugin.
- What a plugin can reach is bounded on each side. Its Worker holds `PLUGIN_KEY`, the secrets
  named for it ([Secrets](#secrets)) and its own D1 database only (`PLUGIN_CONFIG_KEYS`, above); the key opens only requests signed for that plugin.
  Its pages run no script: the web app's CSP for them is `default-src 'none'`, `script-src 'none'`,
  `connect-src 'none'`, `worker-src 'none'`, styles and images from the app's origin, no framing and
  forms posting back to it, since a script would run with the viewer's session on the app's origin.
  Only the headers in `RESPONSE_ALLOWED` pass from the plugin's response, so none that acts on the
  whole origin (`set-cookie`, HSTS, service-worker scope, reporting, site-data clearing,
  permissions); a redirect must lead to `/plugins/<id>/…` on the app's origin, or to an external cart's start
  link (`/cart/start/<cartId>/<token>`, which only the plugin that opened the cart holds), or the
  response is `502`.
- An outbound event reaches a plugin only while it is installed and subscribed when the event is
  emitted; there is no replay for a plugin installed later.

## How the parts connect

- **Nodes**: the Workflow's `runNode` takes a node's spec from the registry and, for a type no
  built-in executor has and whose prefix is a plugin id, runs `execPluginNode` inside the node's
  `step.do`. It sends `execute` with the step's effect key, the order, variables and earlier outputs
  as the manifest's `personalData` allows (`pluginOrder`, `pluginView`), holds the call to
  `PLUGIN_CALL_MS`, checks the result with `checkExecResult` (a bad result, or a `fail` without
  `retry`, is a `NonRetryableError`; `fail` with `retry` throws an ordinary error) and returns it as
  any executor's, with `vars` as `pluginVars`, which `applyResult` merges into `vars.plugins.<id>`
  as a delta. With `rollback: true` it registers `pluginRollback` in place of an entry in
  `ROLLBACKS`. Retries default to the spec's or 3.
  - A plugin that isn't bound at all fails its node with a `NonRetryableError` (`Plugin “<id>” is not
    installed`); one that is bound but isn't answering throws an ordinary error, so the step
    retries.
  - The node's branch and spec are checked against the registry the run was planned with (the
    `load-plugins` snapshot, passed to the executor as `registry`), not the current manifest, so a
    plugin redeployed mid-order can't steer the order down an edge its flow doesn't have.
  - `flowManifests` builds that snapshot: it throws, so `load-plugins` retries, while a plugin the
    flow uses is bound but has no manifest (not answering, or refused), because recording it as
    absent would fail the order for good and run its nodes without their rollbacks. A plugin that
    isn't bound is left out.
- **Providers**: an executor whose node names a provider calls `provide` instead of its built-in
  connector ([Providers](#providers)).
- **Events**: `emit` in `apps/engine/src/outbox.ts` adds a delivery for each installed plugin whose
  `events` match, with subscription id `plugin:<id>`, in `webhook_deliveries` (no schema change; see
  [Data model](data-model.md)). `deliverToPlugin` calls `deliver` over the binding with `data`
  passed through `pluginView` (so redacted unless the plugin is granted buyer details) and never
  throws (a plugin with no manifest is an error to retry); an earlier plugin delivery recorded for
  the same step stays pending and is retried even when the plugin has dropped out of the targets
  (it didn't answer this time); the ids (`whd_<orderId>_<stepKey>_plugin:<id>` with unsafe characters as `_`), retries and the step's `pending` failure
  are the outbox's.
- **Pages**: the web Worker routes `/plugins/*` to `pluginFetch`, which forwards only
  `/plugins/<id>/…` (`pluginPathId`; `/plugins` itself is the admin page) and answers `404` for an
  uninstalled plugin.
  - In: the plugin gets only `accept`, `accept-language`, `content-type`, `content-length` and
    `user-agent`, never the cookie, authorization or proxy headers. A declared body over
    `MAX_PLUGIN_BODY` (10 MiB) is `413`, and a streamed one errors once it passes the cap.
  - A page needs a signed-in caller (`401`, or `403` while setup is due) whose role is at least the
    manifest's `pageRole` (`403`), within the `API_LIMIT` budget per person and plugin (keyed
    `plugin:<id>:<principal id>`, `429` over it). The principal header is signed for that path with
    the plugin's own key (`setPluginPrincipalHeader`, `pluginKey`) and carries `kind`, `id`, `name`,
    `role` and `email`, never a session id; the plugin trusts nothing else.
  - Paths in `publicPaths` skip all of that, for callers that authenticate to the plugin
    themselves, but are rate-limited per plugin and caller address with `WEBHOOK_LIMIT`
    (`429` over it) and get the same body cap.
  - Out: only `cache-control`, `content-disposition`, `content-language`, `content-length`,
    `content-type`, `etag`, `expires`, `last-modified` and `vary` pass (`RESPONSE_ALLOWED`). A
    `location` is kept only if it resolves to `/plugins/<id>/…` on the app's origin, rewritten to a
    path; any other redirect is a `502`. The response gets the app's own `content-security-policy`
    (no script at all, see Limits and hardening), `x-frame-options: DENY`, `x-content-type-options`,
    `referrer-policy`, `cross-origin-opener-policy` and `cross-origin-resource-policy:
    same-origin`, whatever the plugin set. A plugin's page therefore can't run script.
- **Editor and validation**: the shell loads the manifests (`pluginManifests`, from
  `EngineRpc.pluginCatalog`) into `PluginsProvider` (`apps/web/app/lib/plugins.tsx`); components
  read node specs with `useNodes()` (`lib/nodes.tsx`) rather than `nodeSpec`, which builds the
  registry from them where it is used, so the shell's chunk carries no node catalog or zod. The
  shell leaves out nav entries whose `pageRole` the person is below. Server-side flow validation
  uses `nodeRegistry()`.
- **Health and usage**: `EngineRpc.health` adds a check per binding, named like it in lower case
  (`plugin_example`), that re-reads the manifest (bypassing the cache, but at most every 10 seconds) and fails with the status's
  `error` unless the plugin answered with a manifest the engine accepts. `EngineRpc.pluginUsage(id)` (a `failed` order counts until rolled back) backs the admin
  endpoint `GET /api/v1/plugins/:id/usage`. `EngineRpc.pluginCatalog` returns a `PluginStatus` per
  binding; `GET /api/v1/plugins` lists each as `{ binding, id, name, version, nodes, events,
  healthy, error? }`, with `id`, `name` and `version` null for a refused plugin.
