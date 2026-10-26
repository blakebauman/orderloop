# Maintainer docs

How OrderLoop is built, configured, deployed and tested. These pages are for people who work on
OrderLoop or run their own deployment. They are not published.

The public site, [docs.orderloop.app](https://docs.orderloop.app) (`apps/docs`), is for the people
who use a workspace and the developers who integrate with one: flows, orders, approvals, the team,
the REST API, webhooks, channel adapters, email intake, MCP and A2A. When a passage would only
matter to someone with the source or a Cloudflare account (file paths, bindings, env vars,
`wrangler`, D1 tables, Workflow and Durable Object mechanics), it belongs here instead.

| Page | What it covers |
|---|---|
| [Local development](local-development.md) | Install, local D1, `pnpm web:dev`, scenarios, checks |
| [Deploy](deploy.md) | Provisioning, first deploy, CI, Email Routing, production settings, the docs site |
| [Operations](operations.md) | The fleet: one deployment per customer, the registry, rings, adding, holding and removing a customer |
| [Configuration](configuration.md) | Engine, web and catalog variables, secrets, bindings, routes |
| [Architecture](architecture.md) | The web app, the engine, the product catalog Worker, RPC, sockets, connectors, MCP, A2A, the assistant |
| [Planner](planner.md) | Readiness, skips, joins and loops in `packages/core/src/graph.ts` |
| [OrderLoop Workflow](workflow.md) | How the Workflow interprets a flow: steps, waits, rollback, continue-as-new |
| [OrderAgent](order-agent.md) | The per-order Durable Object: state, reports, waits, the socket |
| [Plugins](plugins.md) | Optional features as their own Workers: the manifest and `PluginRpc` contract, writing, installing and removing one |
| [Data model](data-model.md) | D1 tables, R2 keys and the catalog's stores |
| [Product editor](product-editor.md) | The plan for catalog overrides, staged publishing, the gap index and assistant drafts, PR by PR |
| [Testing](testing.md) | The test suites, what each covers, and the recorded runs on the docs home page |

Links to `https://docs.orderloop.app/…` point at the public pages these build on. Keep these files
true to the code in the same change as the code, like the public docs (see the `docs-sync` skill).
