# Plugins

How an optional feature ships as a plugin: its own Worker and D1 database, installed per
deployment from the registry and removable without touching the core. The contract is
`packages/core/src/plugins.ts`; the engine side is `apps/engine/src/plugins.ts`, the web side
`apps/web/app/lib/plugins.server.ts` and `apps/web/app/lib/nodes.tsx`.

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

Every plugin's default entrypoint is a `WorkerEntrypoint` implementing `PluginRpc`:

| Method | Called | Must |
|---|---|---|
| `manifest()` | By the engine, at most every 60 seconds per isolate, and by deep health | Return a `PluginManifest` that `parseManifest` accepts |
| `execute(req)` | Inside a plugin node's own `step.do` | Do the node's work and return `{ branch?, output?, summary?, vars? }`; `branch` must be one of the node's `outputs` (default: the first) |
| `compensate(req)` | When the order fails after a node with `rollback: true` | Undo that run; return a one-line description. May run more than once |
| `deliver(payload)` | From the outbox, for events the manifest lists | Record the event; throw to be retried |
| `fetch(request)` | For `/plugins/<id>/*` | Serve the page; verify the principal header unless the path is public |

The manifest (`pluginManifestSchema`) has:

| Field | Rule |
|---|---|
| `id` | `PLUGIN_ID_RE` (2 to 31 lowercase letters, digits and dashes, starting with a letter); not `trigger`, `commerce`, `control`, `ai`, `core` or `orderloop`; must match the binding it is reached by |
| `name`, `version` | Non-empty. Change `version` whenever the manifest changes |
| `nodes` | `PluginNodeSpec`s: `type` is `<id>.<name>` (name lowercase, digits, underscores); `category` is `commerce`, `control` or `ai`; `label`, `description`, `icon` (a lucide-react name); `fields` (the catalog's field kinds, with `jsonSchema` in place of a zod schema); `outputs` (at least one, fixed); optional `rollback` and `retries` (0 to 10, default 3). A type the built-in catalog has is refused |
| `events` | Outbound event names, or `"*"` for all |
| `nav` | `{ label, path, icon }`; each `path` starts with `/plugins/<id>/` |
| `publicPaths` | Exact paths under `/plugins/<id>/` forwarded with no signed-in person |
| `requires` | Ids of plugins that must also be installed |

The engine leaves a plugin out (and logs `plugin manifest refused` or `plugin missing requirements`)
when its manifest doesn't parse, its `id` doesn't match its binding, or a required plugin is absent.
Its nodes then read as `Plugin “<id>” is not installed`, and every other flow keeps running.

`execute` receives `PluginExecRequest`: `type`, `nodeId`, `stepKey`, `orderId`, the node's `config`
with defaults filled in (expressions not yet evaluated), the `order`, `vars` and earlier nodes'
outputs (`nodes`). `compensate` receives the same ids and the `output` that `execute` returned.

## Writing a plugin

Copy `plugins/example/` (a test-only fixture covering every extension point; fleet refuses to
install it). It has:

- `wrangler.jsonc`: the Worker, `workers_dev` and `preview_urls` off, and a `DB` D1 binding with a
  `migrations_dir`. The fleet renders the name (`orderloop-plugin-<id><suffix>`) and the database
  id, so what the file holds are the base names only.
- `src/index.ts`: the entrypoint. `execute` inserts a row keyed by `(order_id, step_key)` with
  `ON CONFLICT DO NOTHING`, `compensate` deletes that row, `deliver` inserts the delivery id with
  `ON CONFLICT DO NOTHING`, and `fetch` verifies the principal with `verifyPrincipal` (keys
  `PRINCIPAL_KEY` and `PRINCIPAL_KEY_PREVIOUS`, header `PRINCIPAL_HEADER`, bound to the request path)
  except on its public path.
- `migrations/`: the plugin's own D1 migrations. As with the core's, they must work with the code
  already deployed: add first, drop or rename later.
- `package.json` named `@orderloop/plugin-<id>`, depending on `@orderloop/core` (workspace packages
  are `plugins/*`, in `pnpm-workspace.yaml`).

Then add tests (see [Testing](testing.md#plugins)). Run `pnpm install` to link the new package.

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
the shell. `GET /api/v1/plugins` lists what is installed.

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
  `step.do`. It sends `execute` with the step's effect key, rejects a `branch` that isn't one of the
  spec's `outputs`, and returns the result as any executor's. With `rollback: true` it registers
  `pluginRollback` in place of an entry in `ROLLBACKS`. Retries default to the spec's or 3.
- **Events**: `emit` in `apps/engine/src/outbox.ts` adds a delivery for each installed plugin whose
  `events` match, with subscription id `plugin:<id>`, in `webhook_deliveries` (no schema change; see
  [Data model](data-model.md)). `deliverToPlugin` calls `deliver` over the binding and never throws;
  the ids (`whd_<orderId>_<stepKey>_plugin:<id>` with unsafe characters as `_`), retries and the step's `pending` failure
  are the outbox's.
- **Pages**: the web Worker routes `/plugins/*` to `pluginFetch`. It answers `404` for an uninstalled
  plugin, strips `cookie` and `authorization`, requires a signed-in caller (`401`, or `403` while
  setup is due) and signs the principal header for that path; the plugin trusts nothing else. Paths in
  `publicPaths` skip all of that, for callers that authenticate to the plugin themselves.
- **Editor and validation**: the shell loads the manifests (`pluginManifests`, from
  `EngineRpc.pluginCatalog`) into `NodesProvider`; components read node specs with `useNodes()`
  rather than `nodeSpec`. Server-side flow validation uses `nodeRegistry()`.
- **Health and usage**: `EngineRpc.health` adds a check per binding, named like it in lower case
  (`plugin_example`), that calls `manifest()`. `EngineRpc.pluginUsage(id)` backs the admin
  endpoint `GET /api/v1/plugins/:id/usage`.
