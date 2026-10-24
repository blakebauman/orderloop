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
D1 database of its own, and deploys it before the engine. It contributes up to four things, all
optional:

- **Nodes**, namespaced `<id>.<name>`, which the editor offers and the Workflow runs.
- **Event subscriptions** to outbound events, delivered over the binding instead of HTTP.
- **Pages** under `/plugins/<id>/`, served by the plugin and linked from the nav.
- **Public paths** under `/plugins/<id>/` that are forwarded without a signed-in person.

It is not a way to change the core. A plugin owns its tables (the core's schema and migrations never
mention one), reaches OrderLoop only through `PluginRpc`, and gets no `env` of the engine or web app.
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
    The page runs no script (see [Limits and hardening](#limits-and-hardening)); render HTML whose links and
    forms come back to `/plugins/<id>/`.
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

### Idempotency

The engine retries steps and replays Workflows, and the outbox redelivers. A plugin must tolerate
both:

- Key every write in `execute` by `orderId` and `stepKey` together. `stepKey` is unique within the
  order and the same on every retry of that step (the node's effect key, `effectKey(generation, key)`).
- Key every write in `compensate` the same way, and make a second call harmless.
- Key every write in `deliver` by `payload.id`, which is stable across redeliveries.

If the plugin calls an external system, pass that system the same key.

## Installing

1. Add the plugin to the deployment's registry file, `deployments/<id>.jsonc`:
   `"plugins": { "qbd-sync": {} }`. `loadDeployments` refuses an id that isn't a plugin id, one that is a
   fixture (`example`), and one without `plugins/<id>/wrangler.jsonc`. An entry holds `d1Id` and
   `personalData`, and no other key.
   **Granting buyer details**: a plugin whose manifest says `personalData: 'send'` is refused (its
   status is `healthy: false` with `error` `It asks for buyer details…`) unless its entry says
   `"personalData": "send"`: `"plugins": { "qbd-sync": { "personalData": "send" } }`. Only that value
   is accepted. `renderEngine` writes the grants into the engine's `PLUGIN_GRANTS` variable
   (`{"qbd-sync":{"personalData":"send"}}`), which the engine reads on every status check. Removing
   the grant refuses the plugin on the next deploy, even if its last good manifest asked for `send`.
   Grant it only after reviewing what the plugin does with buyer details.
2. Run `./scripts/provision.sh <deployment>`. For each plugin it creates the D1 database
   `orderloop-plugin-<id><suffix>` and records its id with `fleet.ts set-plugin-d1`, as `plugins.<id>.d1Id`.
   A deployment with a plugin lacking `d1Id` fails `fleet.ts matrix` (CI's plan) unless it is held.
3. Merge. CI's deploy job (`.github/workflows/deploy.yml`) renders `plugins/<id>/wrangler.<deployment>.json`,
   writes one secrets file per plugin (`fleet.ts secrets plugin <out> <plugin>`), holding that
   plugin's own `PLUGIN_KEY` and, during a rotation, `PLUGIN_KEY_PREVIOUS`; then in the **Deploy
   plugins** step applies each plugin's D1 migrations and deploys its Worker with its file, all
   before the engine, because the engine and web Worker bind
   to it. The engine's and web Worker's configs gain a service binding per plugin.

A plugin never holds `PRINCIPAL_KEY`. `pluginKey(principalKey, id)` (`packages/core/src/plugins.ts`,
mirrored by `scripts/fleet.ts`; `scripts/fleet.test.ts` holds both to the same vector) is the
hex HMAC-SHA256 of the principal key over `orderloop-plugin:<id>`. The web Worker signs a plugin's
page requests with it, so the engine and every other plugin, which hold other keys, refuse a
principal signed for this one, and a plugin can't sign requests to them. Rotating `PRINCIPAL_KEY`
([Operations](operations.md#rotating-the-principal-key)) rotates every plugin's key too, with
`PLUGIN_KEY_PREVIOUS` covering the gap.

A plugin's first deploy has no earlier version to roll back to; a failed deploy rolls back the plugins
that did deploy, with the rest.

Within a minute per isolate the plugin's nodes appear in the editor palette and its `nav` entries in
the shell (for people at or above its `pageRole`). Admins see what is installed at **Plugins**
(`/plugins`, in the account menu), and `GET /api/v1/plugins` lists it.

## The Plugins page

`apps/web/app/routes/plugins.tsx` is an admin-only page. For each `PLUGIN_*` binding
(`EngineRpc.pluginCatalog`) it shows whether the plugin is answering, refused, or not answering
while running its last manifest, with the `error`; its contract version, whether buyer details are
redacted or sent, who may open its pages and its public paths, its events, what it `requires`, and
its nodes with their category, outputs and whether they roll back. For a plugin with a manifest it
adds what uses it (`pluginUsage`: published flows and the number of orders not yet ended) and, for one
with events or earlier deliveries, its ten most recent deliveries (subscription `plugin:<id>`) with
status, attempts and last error. A refused plugin has no manifest, so its id comes from its binding
and the page shows the same usage and deliveries, when its flows and orders matter most. It is read-only: installing and removing a plugin is a change to the deployment.

## Removing

A published flow or a running order that uses a removed plugin's nodes fails, so check first.

1. Run `ORDERLOOP_API_TOKEN=ol_… pnpm plugin:check <deployment> <plugin>` (`scripts/plugin-check.ts`),
   with an admin's API token. It calls `GET /api/v1/plugins/<plugin>/usage` on the deployment and
   prints each published flow (`pluginUsage`: the published version, not archived) and each order not
   yet ended whose flow version uses the plugin's nodes (a `failed` order counts until it is rolled
   back, since its compensations still call the plugin), and exits `1` if there are any.
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
  import app code.
- What a plugin can reach is bounded on each side. Its Worker holds `PLUGIN_KEY` and its own D1
  database only (`PLUGIN_CONFIG_KEYS`, above); the key opens only requests signed for that plugin.
  Its pages run no script: the web app's CSP for them is `default-src 'none'`, `script-src 'none'`,
  `connect-src 'none'`, `worker-src 'none'`, styles and images from the app's origin, no framing and
  forms posting back to it, since a script would run with the viewer's session on the app's origin.
  Only the headers in `RESPONSE_ALLOWED` pass from the plugin's response, so none that acts on the
  whole origin (`set-cookie`, HSTS, service-worker scope, reporting, site-data clearing,
  permissions); a redirect must lead to `/plugins/<id>/…` on the app's origin or the response is
  `502`.
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
