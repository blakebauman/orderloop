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

`checkExecResult` holds an `execute` result to the contract. A result that breaks it fails the node
without a retry, since the same code would answer the same again:

| Result | Rule |
|---|---|
| `branch` | One of the node's `outputs`; default the first. Otherwise `<type> chose “<branch>”, which isn't one of its outputs` |
| `summary` | At most `PLUGIN_SUMMARY_MAX` (300) characters |
| `output`, `vars` | Each at most `PLUGIN_RESULT_MAX_BYTES` (128 KiB) serialized as JSON |
| `vars` | Merged into the order's variables under the plugin's id, as `vars.<id>`, so a plugin can't overwrite the flow's variables or another plugin's |
| `{ fail: { message, retry? } }` | Fails the node with `message` (1 to 300 characters). `retry: true` throws an ordinary error, so the step retries as when `execute` throws; otherwise it is a `NonRetryableError` and the order rolls back |

The manifest (`pluginManifestSchema`) has:

| Field | Rule |
|---|---|
| `apiVersion` | Must be `PLUGIN_API_VERSION` (`1`); a manifest for any other version is refused |
| `id` | `PLUGIN_ID_RE` (2 to 31 lowercase letters, digits and dashes, starting with a letter); not `trigger`, `commerce`, `control`, `ai`, `core` or `orderloop`; must match the binding it is reached by |
| `name`, `version` | Non-empty. Change `version` whenever the manifest changes |
| `nodes` | `PluginNodeSpec`s: `type` is `<id>.<name>` (name lowercase, digits, underscores); `category` is `commerce`, `control` or `ai`; `label`, `description`, `icon` (a lucide-react name); `fields` (the catalog's field kinds, with `jsonSchema` in place of a zod schema); `outputs` (at least one, fixed); optional `rollback` and `retries` (0 to 10, default 3). A type the built-in catalog has is refused |
| `events` | Outbound event names, or `"*"` for all |
| `nav` | `{ label, path, icon }`; each `path` starts with `/plugins/<id>/` |
| `publicPaths` | Exact paths under `/plugins/<id>/` forwarded with no signed-in person |
| `requires` | Ids of plugins that must also be installed |
| `pageRole` | The least role that may open the plugin's pages and see its nav entries; default `operator` |
| `personalData` | `redact` (default) or `send`: whether `execute` is sent who the buyer is |

`pluginStatuses` (engine) reports a `PluginStatus` per `PLUGIN_*` binding: `binding`, `manifest`,
`healthy` and `error`. When a manifest doesn't parse or its `id` doesn't match its binding (for
example mid-deploy, or a blip), the plugin is `healthy: false` and the engine keeps running the last
good manifest it saw from that binding, so its nodes don't read as missing and fail running orders;
with none, `manifest` is `null`. When a required plugin is absent the manifest is `null` too and the
`error` is `Needs <ids> installed`. Both are logged (`plugin manifest refused`, `plugin missing
requirements`). A plugin with no manifest reads as `Plugin “<id>” is not installed` on its nodes,
and every other flow keeps running.

`execute` receives `PluginExecRequest`: `type`, `nodeId`, `stepKey`, `orderId`, the node's `config`
with defaults filled in (expressions not yet evaluated), the `order`, `vars` and earlier nodes'
outputs (`nodes`). `compensate` receives the same ids and the `output` that `execute` returned.

With `personalData: 'redact'` the `order` (`pluginOrder`), `vars` and `nodes` (`pluginView`) are sent
as AI nodes get them: contact, names and addresses are removed and emails and phone numbers in free
text are masked. Line items keep their product names. Set `send` only when the plugin needs to know
who the buyer is.

## Writing a plugin

Copy `plugins/example/` (a test-only fixture covering every extension point; fleet refuses to
install it) and build on `@orderloop/plugin-sdk`. It has:

- `wrangler.jsonc`: the Worker, `workers_dev` and `preview_urls` off, and a `DB` D1 binding with a
  `migrations_dir`. The fleet renders the name (`orderloop-plugin-<id><suffix>`) and the database
  id, so what the file holds are the base names only.
- `src/index.ts`: `export default definePlugin<Env>({ manifest, nodes, events, pages })`.
  `definePlugin` returns the `PluginRpc` entrypoint class and checks the definition when the Worker
  loads, so a mistake fails the deploy rather than an order: the manifest must parse
  (`parseManifest`), every manifest node needs a handler in `nodes` (by name: `stamp` for
  `example.stamp`) and every handler a node, a `rollback` node needs `compensate`, `events` handlers
  must be subscribed in the manifest, and a manifest with `nav` or `publicPaths` needs `pages`.
  - A node handler's `execute({ req, env, key, fail })` gets `key`, `<orderId>:<stepKey>`, the one
    key to write by, and `fail(message, { retry? })` to build the failing result. `compensate`
    gets the same `key` and returns a one-line description.
  - An `events` handler is called by event name; an event without one is ignored.
  - `pages(request, { env, principal })` is called after the SDK verified the principal header
    (keys `PRINCIPAL_KEY` and `PRINCIPAL_KEY_PREVIOUS`, header `PRINCIPAL_HEADER`, bound to the
    request path) and checked `pageRole`: `401` without a valid principal, `403` below the role.
    On a `publicPaths` entry it runs with `principal: null`, so authenticate the caller yourself.
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

It checks that the manifest parses for this contract version; that running each node twice for the
same order and step key gives the same result and no second effect; that, for a `rollback` node,
compensating twice leaves the effect count it had before `execute`; that delivering the same event
twice records it once; and that the first nav page answers `401` without a signed-in person, `403`
to the role below `pageRole`, and neither to `pageRole` itself. `cases` supplies `effects(orderId)`
(count the plugin's rows for an order), and, as the manifest needs them, `deliveries(payloadId)`,
`principalKey`, plus optional `configs` per node type, an `order` and a `pagePath`. Run it from the
plugin's own tests in workerd: `plugins/example/vitest.config.ts` is a `cloudflareTest` project with
the plugin's migrations applied in `tests/setup.ts` and a `PRINCIPAL_KEY`. Every plugin ships one.

`bundlePlugin(entry, { name, d1, bindings })` (`@orderloop/plugin-sdk/testing`, Node only) bundles a
plugin with esbuild into a Miniflare auxiliary Worker for another package's vitest config; the
engine's `plugins` project binds the example this way.

To try a plugin in the app locally, apply its migrations to the dev session's state and name it in
`ORDERLOOP_DEV_PLUGINS` (comma-separated). `apps/web/vite.config.ts` then runs it as one more
auxiliary Worker, bound to the web app and the engine as `PLUGIN_<ID>`:

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
   fixture (`example`), and one without `plugins/<id>/wrangler.jsonc`.
2. Run `./scripts/provision.sh <deployment>`. For each plugin it creates the D1 database
   `orderloop-plugin-<id><suffix>` and records its id with `fleet.ts set-plugin-d1`, as `plugins.<id>.d1Id`.
   A deployment with a plugin lacking `d1Id` fails `fleet.ts matrix` (CI's plan) unless it is held.
3. Merge. CI's deploy job (`.github/workflows/deploy.yml`) renders `plugins/<id>/wrangler.<deployment>.json`,
   writes the plugin secrets (`fleet.ts secrets plugin`: `PRINCIPAL_KEY` and, during a rotation,
   `PRINCIPAL_KEY_PREVIOUS`), then in the **Deploy plugins** step applies each plugin's D1
   migrations and deploys its Worker, all before the engine, because the engine and web Worker bind
   to it. The engine's and web Worker's configs gain a service binding per plugin.

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
adds what uses it (`pluginUsage`: published flows and the number of running orders) and, for one
with events, its ten most recent deliveries (subscription `plugin:<id>`) with status, attempts and
last error. It is read-only: installing and removing a plugin is a change to the deployment.

## Removing

A published flow or a running order that uses a removed plugin's nodes fails, so check first.

1. Run `ORDERLOOP_API_TOKEN=ol_… pnpm plugin:check <deployment> <plugin>` (`scripts/plugin-check.ts`),
   with an admin's API token. It calls `GET /api/v1/plugins/<plugin>/usage` on the deployment and
   prints each published flow (`pluginUsage`: the published version, not archived) and each order not
   in a terminal status whose flow version uses the plugin's nodes, and exits `1` if there are any.
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

## Limits

- No trigger, waiting or looping nodes: `category` is `commerce`, `control` or `ai`, and a plugin
  node runs in one step and picks a branch from fixed `outputs`.
- A node's `icon` outside the app's set (`apps/web/app/components/node-icon.tsx`) shows as a puzzle piece.
- A call into a plugin is bounded (`PLUGIN_CALL_MS`, 60 seconds for `execute` and `compensate`; 30
  for `deliver`; 10 for `manifest`), and a result is bounded (see the contract). The engine hands a
  plugin buyer details only with `personalData: 'send'`.
- Manifests are cached about 60 seconds per isolate, in the engine (`MANIFEST_TTL_MS`) and in the web
  app, so a redeployed plugin's nodes and pages show up after that. A flow with plugin nodes reads
  the manifests once in a durable `load-plugins` step so a replay sees the same specs; flows
  without them add no step.
- A plugin's pages load as whole documents (`reloadDocument`), not as app routes, and it can't
  import app code.
- An outbound event reaches a plugin only while it is installed and subscribed when the event is
  emitted; there is no replay for a plugin installed later.

## How the parts connect

- **Nodes**: the Workflow's `runNode` takes a node's spec from the registry and, for a type no
  built-in executor has and whose prefix is a plugin id, runs `execPluginNode` inside the node's
  `step.do`. It sends `execute` with the step's effect key, the order, variables and earlier outputs
  as the manifest's `personalData` allows (`pluginOrder`, `pluginView`), holds the call to
  `PLUGIN_CALL_MS`, checks the result with `checkExecResult` (a bad result, or a `fail` without
  `retry`, is a `NonRetryableError`; `fail` with `retry` throws an ordinary error) and returns it as
  any executor's, with `vars` under `vars.<id>`. With `rollback: true` it registers `pluginRollback`
  in place of an entry in `ROLLBACKS`. Retries default to the spec's or 3.
- **Events**: `emit` in `apps/engine/src/outbox.ts` adds a delivery for each installed plugin whose
  `events` match, with subscription id `plugin:<id>`, in `webhook_deliveries` (no schema change; see
  [Data model](data-model.md)). `deliverToPlugin` calls `deliver` over the binding and never throws;
  the ids (`whd_<orderId>_<stepKey>_plugin:<id>` with unsafe characters as `_`), retries and the step's `pending` failure
  are the outbox's.
- **Pages**: the web Worker routes `/plugins/*` to `pluginFetch`, which forwards only
  `/plugins/<id>/…` (`pluginPathId`; `/plugins` itself is the admin page) and answers `404` for an
  uninstalled plugin.
  - In: the plugin gets only `accept`, `accept-language`, `content-type`, `content-length` and
    `user-agent`, never the cookie, authorization or proxy headers. A declared body over
    `MAX_PLUGIN_BODY` (10 MiB) is `413`, and a streamed one errors once it passes the cap.
  - A page needs a signed-in caller (`401`, or `403` while setup is due) whose role is at least the
    manifest's `pageRole` (`403`), and the principal header is signed for that path; the plugin
    trusts nothing else.
  - Paths in `publicPaths` skip all of that, for callers that authenticate to the plugin
    themselves, but are rate-limited per plugin and caller address with `WEBHOOK_LIMIT`
    (`429` over it) and get the same body cap.
  - Out: the response loses `set-cookie` and the hop-by-hop headers, and gets the app's own
    `content-security-policy` (scripts from the app's origin only, no framing, forms post back to
    it), `x-frame-options: DENY`, `x-content-type-options`, `referrer-policy` and
    `cross-origin-opener-policy`, whatever the plugin set. A plugin's page therefore can't use
    inline script.
- **Editor and validation**: the shell loads the manifests (`pluginManifests`, from
  `EngineRpc.pluginCatalog`) into `PluginsProvider` (`apps/web/app/lib/plugins.tsx`); components
  read node specs with `useNodes()` (`lib/nodes.tsx`) rather than `nodeSpec`, which builds the
  registry from them where it is used, so the shell's chunk carries no node catalog or zod. The
  shell leaves out nav entries whose `pageRole` the person is below. Server-side flow validation
  uses `nodeRegistry()`.
- **Health and usage**: `EngineRpc.health` adds a check per binding, named like it in lower case
  (`plugin_example`), that re-reads the manifest without the cache and fails with the status's
  `error` unless the plugin answered with a manifest the engine accepts. `EngineRpc.pluginUsage(id)` backs the admin
  endpoint `GET /api/v1/plugins/:id/usage`. `EngineRpc.pluginCatalog` returns a `PluginStatus` per
  binding; `GET /api/v1/plugins` lists each as `{ binding, id, name, version, nodes, events,
  healthy, error? }`, with `id`, `name` and `version` null for a refused plugin.
