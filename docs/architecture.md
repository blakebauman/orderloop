# Architecture

The Workers, the service binding between web and engine, the packages, the bindings and the connectors.

OrderLoop is two Workers in one pnpm monorepo, plus the product catalog's two Workers (see
[Product catalog](#product-catalog)). `orderloop-web` serves the dashboard, the flow
editor and the REST API; `orderloop-engine` runs orders. The web app reaches the engine only
through a service binding, and the engine has no public URL.

```
browser ──► orderloop-web (apps/web, React Router on Workers)
              │  D1: flows + versions, orders index, approvals, back office
              │  R2: order documents
              ├── CATALOG service binding ─RPC──► orderloop-catalog (apps/catalog, CatalogApi)
              ├── ENGINE service binding ──RPC──► orderloop-engine (apps/engine)
              │                                     ├─ EngineApi      WorkerEntrypoint (RPC)
              ├── /agents/order-agent/:id ─fetch─►  ├─ OrderAgent     Durable Object, one per order
              ├── /agents/assistant-agent/* ─────►  ├─ AssistantAgent Durable Object, one per person
              ├── /agents/cart-agent/:id ────────►  ├─ CartAgent      Durable Object, one per cart
              └── /a2a (fetch, via OAuth) ───────►  ├─ A2AAgent       Durable Object, one per caller
                                                    ├─ OrderLoop      Workflow, one instance per generation
                                                    ├─ Replenish      Workflow, daily cron
inbound mail ── Email Routing ──email()────────────►├─ receiveEmail   email intake (email.ts)
                                                    └─ Workers AI, D1, R2
```

## Packages

| Path | Role |
|---|---|
| `packages/core` (`@orderloop/core`) | Flow schema, node catalog, planner and validation, inbound order payload and routing, layout, JSON Logic expressions, policy rules, address checks, the pricing chain resolver, templates, webhook signing, the `EngineRpc` contract. The product catalog's pure model is its own entry point, `@orderloop/core/product` (`src/product/`): types, validation, routing, rendering, the listing index and `listingSpec`, feed parsing and the `ProductCatalogRpc` contract. Where published objects live and their cache tags are the zod-free `@orderloop/core/product/paths` (`DOC_FORMAT`, the `CODE`, `LOCALE` and `SLUG` patterns, `BATCH_MAX`, `paths`, `tags`), and the listing index's decoder and merged query are the zod-free `@orderloop/core/product/listing` (`ListingIndex`, `queryListing`, the cursor functions and `LISTING_SEGMENTS`, re-exported from `routing.ts`, which imports nothing); `catalog-edge` imports only those two. No bindings and no Cloudflare imports |
| `plugins/<id>` | Optional features, each its own Worker and D1 database or a sandboxed bundle the engine loads, installed per deployment; see [Plugins](plugins.md). `plugins/example` is a test-only fixture |
| `packages/plugin-sdk` (`@orderloop/plugin-sdk`) | What plugins are built with: `definePlugin` (the `PluginRpc` entrypoint), the `pluginContract` suite and `bundlePlugin` for tests; see [Plugins](plugins.md) |
| `packages/db` (`@orderloop/db`) | Drizzle schema for D1, numbered SQL migrations, demo seed data (`seed/`, local and tests only), flow persistence (`getFlowVersionJson`, `publishFlow`) |
| `packages/ui` (`@orderloop/ui`) | shadcn/ui primitives, consumed as raw `.tsx` |
| `apps/engine` (`@orderloop/engine`) | `OrderAgent`, `AssistantAgent`, `CartAgent`, `OrderLoop`, `Replenish`, node executors, connectors, AI calls, outbox, `EngineApi` |
| `apps/catalog` (`@orderloop/catalog`) | The product catalog Worker: `CatalogShard`, `CatalogMeta` and `CatalogPublisher` Durable Objects, the publisher, `CatalogApi` |
| `apps/catalog-edge` (`@orderloop/catalog-edge`) | The public, read-only catalog API: the gateway, the cached `Delivery` entrypoint and the purge queue consumer |
| `apps/web` (`@orderloop/web`) | Dashboard, editor, live order view, approvals inbox, Commerce page, `/api/v1` |
| `apps/docs` (`@orderloop/docs`) | This site |

`packages/core` is pure TypeScript so its semantics can be unit tested in Node: anything that needs
`env` belongs in an app. The planner lives there, not in the Workflow
(see [Planner](planner.md)).

## The engine contract

`EngineRpc` in `packages/core/src/api.ts` is the whole surface the web app may use:

| Method | What it does |
|---|---|
| `startOrder(input)` | Inserts the order row, initialises its `OrderAgent`, creates generation 1 of `OrderLoop`. Honours `idempotencyKey` |
| `startOrderOnce(input)` | Starts an order at most once per idempotency key (`POST /api/v1/orders` with an `Idempotency-Key`, signed inbound orders and email intake use it); a replay returns the existing order, or `{ mismatch: true }` for a different request |
| `sendEvent(orderId, event, payload?)` | Delivers a business event to the node waiting for it; returns `{ delivered, nodeId? }`, with `notFound` for an unknown order |
| `decide(orderId, nodeId, decision, actor, note?)` | Approves or rejects the approval a node waits on. `actor` is a staff `RpcActor` the web app signed for `decide:<orderId>` (`signRpcActor`, the `a1` envelope under `PRINCIPAL_KEY`, 60 seconds; `signedActor` in `principal.server.ts`): its name is what the record carries, its id the principal checked against `orders.started_by` when the workspace's `approval_separation` is `on`. Returns `{ ok: true }` or `{ ok: false, reason }` (`not_found`, `not_waiting`, `forbidden` for an actor not signed for this call, or `own_order`, with the refusal in `error`). A staff actor below Approver is `forbidden` too. The cart methods (`changeCart`, `submitCart`, `cancelCart`, `attachToCart`) take an actor signed for `cart:<cartId>` the same way, refused without one. These are the calls that act as a person; the binding's other methods (plugin installs, data subjects, `cancel`, `sendEvent`) still trust their caller, which only the web app is |
| `cancel(orderId, reason)` | Terminates the Workflow and compensates; returns `{ ok: true }` or `{ ok: false, reason }` (`not_found`, `finished`) |
| `snapshot(orderId)` | The agent's `OrderState`, or `null` for an unknown order |
| `copilot(req)` | Edits or creates a flow graph from a prompt |
| `intakeMailboxes()` | The email intake mailboxes (local part → flow id) from the engine's `INTAKE_MAILBOXES`, for the Commerce page |
| `exportDataSubject(email)` | Everything held about the person with that email (`subjects.ts`): customer accounts, up to 500 orders with their agent state, messages, intake log rows, documents; see [Personal data](data-model.md#personal-data) |
| `eraseDataSubject(email)` | Erases that person (100 orders a call, `done` says whether to call again) or returns `{ ok: false, reason: 'active_orders', orders }`. Calls each order's `OrderAgent.erasePersonalData` |
| `runReplenish()` | Creates a `Replenish` instance now |
| `pluginCatalog()` | A `PluginStatus` per installed [plugin](plugins.md) (a `PLUGIN_*` binding or a pinned bundle): its `id`, `runtime`, the manifest the deployment runs, `healthy` and `error` (cached about 60 seconds per isolate) |
| `pluginUsage(id)` | The published flows and running orders that use a plugin's nodes or name it as a provider, and the labels it couldn't void (`GET /api/v1/plugins/:id/usage`) |
| `pluginFetch(id, request)` | A sandboxed plugin's page: the web app builds the request and the engine, the only Worker that can load the plugin, forwards it to the plugin; `404` for a plugin that isn't installed sandboxed |

`EngineApi` (`apps/engine/src/api.ts`) implements it as a `WorkerEntrypoint`. Every method except
`startOrder`, `startOrderOnce`, `copilot`, `intakeMailboxes`, `exportDataSubject`, `eraseDataSubject`, `ucpProfile`, `runReplenish`, `pluginCatalog`, `pluginUsage` and `pluginFetch` forwards to the order's agent via
`orderAgent(env, orderId)` (`apps/engine/src/namespaces.ts`). `EngineApi` trusts its caller: authorization happens in the web
app before the call. The forwarded requests (sockets, `/mcp`, `/a2a`, `/ucp/*`) carry a principal the engine believes only when it is signed with `PRINCIPAL_KEY` for that path and unexpired (`forwardedPrincipal`). The web app types its `ENGINE` binding with `EngineRpc` and never imports
engine source.

## Request routing

`apps/web/workers/app.ts` routes every request before React Router sees it:

| Path | Handling |
|---|---|
| `GET /health` | `{ ok: true, service: "orderloop-web" }` |
| `/plugins/:id/*` | `pluginFetch` (`apps/web/app/lib/plugins.server.ts`): forwarded to the plugin's `PLUGIN_<ID>` binding, or for a sandboxed plugin through `EngineRpc.pluginFetch`, with a signed principal, or with none on the manifest's `publicPaths`; `404` when the plugin isn't installed ([Plugins](plugins.md)) |
| `GET /health/deep` | `runHealthChecks` over this Worker's D1 and R2 and `EngineRpc.health()` (the engine's D1 and R2): `{ ok, service, checks: { db, docs, engine } }`, each `"ok"` or `"fail"`, with `503` when any fails. The deploy smoke test calls it |
| `POST /api/v1/webhooks/events` | `handleSignedEvent`: authenticated by `readSigned`, an HMAC with the secret of the integration the signature names (`k=`, `findIntegration` in `apps/web/app/lib/integrations.server.ts`; the previous secret too during a rotation), then held to its scope (`allowsEvent` in `packages/core/src/integrations.ts`: its events, and its channel's orders only) |
| `POST /api/v1/webhooks/orders` | `handleSignedOrder`: the same HMAC check (`readSigned`), then `inboundOrderSchema`, the integration's scope (`allowsOrder`: it may start orders, on its channel, naming only its `flows`), a currency check, the flow from `flowId`, `ORDER_ROUTES` or the model's default (`flowForOrder`), a check that it is published, and `EngineRpc.startOrderOnce` keyed `order:<channel>:<externalId>`. See [Inbound orders](https://docs.orderloop.app/guides/inbound-orders/) |
| `POST /api/v1/webhooks/stripe` | `handleStripeWebhook` (`apps/web/app/lib/stripe.server.ts`), before authentication: `verifyStripeSignature` (any `v1` in `Stripe-Signature`) against `STRIPE_WEBHOOK_SECRET` (`503` unset, `400` bad signature or not an event), the `WEBHOOK_LIMIT` budget keyed `stripe`, then `EngineRpc.paymentEvent`: `409` when the outcome is `retry`, `500` when the engine throws, else `200`. Stripe signs with the endpoint's secret, not an integration key, so no integration scope applies; the engine dedupes on the event id (`payment_events`) |
| `POST /api/v1/channels/shopify/orders` | `handleShopifyOrder`, before authentication: `verifyShopifyHmac` against `SHOPIFY_WEBHOOK_SECRET` (`503` unset, `401` bad), `X-Shopify-Shop-Domain` in `SHOPIFY_SHOPS` (`503` unset, `403` another store), other `X-Shopify-Topic` values answered `{ ignored: true }`, then `shopifyToInbound` with `customerIdByEmail` and the shared `startInbound` (currency, routing, publish check, `startOrderOnce`). See [Channel adapters](https://docs.orderloop.app/guides/channel-adapters/) |
| `GET /api/v1/openapi.json` | The OpenAPI document, public, `cache-control: public, max-age=300` |
| `/api/v1/*` | `apiPrincipal` (an `ol_live_` token or the session cookie; `401` for none, a bearer that isn't an `ol_live_` token, or an expired token, `403` while the person's two-factor setup is due), then `handleApi(request, caller)`, which checks each route's role. `POST /api/v1/channels/edi/850` is one of its routes (`operator`): `parseX12`, the sender looked up in `EDI_PARTNERS`, then `x12850ToInbound` and `startInbound` for each transaction |
| `/agents/order-agent/*`, `/agents/cart-agent/*`, `/agents/assistant-agent/*` (a cart's socket with no staff sign-in, or asking `as=guest` as the buyer's page does, takes its buyer's cookie instead and is signed as a `CartGuest`, never falling back to staff; see [External carts](#external-carts)) | `principal`, then proxied to the engine's `fetch` (`routeAgentRequest`) with the caller signed into `x-orderloop-principal` (replacing any the browser sent) and `cookie` and `authorization` deleted, carrying the Agents SDK WebSocket. For the assistant the instance name is replaced with the caller's id, so everyone reaches only their own |
| `GET /.well-known/agent-card.json` | `agentCard(origin)` from core, public, `cache-control: public, max-age=300` |
| `GET /mcp/server-card`, `GET /.well-known/ai-catalog.json` | `mcpDiscovery` (`apps/web/app/lib/mcp-discovery.ts`), public: the MCP Server Card (SEP-2127; name `<reversed host>/mcp`, the `/mcp` remote and `MCP_PROTOCOL_VERSIONS`, no tools or capabilities) and the AI Catalog entry that links it. `application/mcp-server-card+json` / `application/ai-catalog+json`, `Access-Control-Allow-Origin: *`, `public, max-age=3600`, an `ETag` honoured with `304`, `OPTIONS` `204`, other methods `405` |
| `GET /.well-known/ucp`, `/ucp`, `/ucp/*` | `ucpDiscovery` and `ucpFetch` (`apps/web/app/lib/ucp.server.ts`), before the OAuth paths. See [UCP](#ucp-agentic-checkout) |
| `/mcp`, `/a2a`, `/.well-known/oauth-*`, `/oauth/*` | `oauthFetch` (`apps/web/app/lib/oauth.server.ts`), before everything else. `/oauth/authorize` is excluded: it is the consent page, a React Router route |
| `/docs/orders/*` | `principal`, then the R2 object, served with `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (without `sandbox` for a PDF, which the browser's viewer couldn't show sandboxed) and `x-content-type-options: nosniff`, its `etag` and `cache-control: private, no-cache` (so each view checks the sign-in); a matching `If-None-Match` is a `304` without the body (R2 `onlyIf`) |
| `GET /login/sso`, `GET /login/sso/callback`, `/login/sso/link` | React Router loader routes for single sign-on (`apps/web/app/lib/sso.server.ts`; rules in `sso.ts`). `/login/sso` redirects to `/login` unless `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are all set, spends the `API_LIMIT` budget per address, fetches the issuer's discovery document (cached an hour; its `issuer` must match, its endpoints must be https) and redirects to the authorization endpoint: code flow, PKCE `S256`, `state` and `nonce`, kept with the code verifier and the next path in the 10-minute `__Host-ol_sso` cookie (`SameSite=Lax`, so the provider's top-level redirect carries it), sealed with `PRINCIPAL_KEY` as its own `sf1` envelope (`signSsoFlow` / `verifySsoFlow` in `packages/core/src/roles.ts`; `PRINCIPAL_KEY_PREVIOUS` also accepted), so an edited or expired one is refused as no sign-in in progress. The callback checks the cookie and `state`, swaps the code at the token endpoint (`client_secret_basic`, or the secret in the body when the provider lists methods without it), verifies the ID token with `jose` (signature from `jwks_uri`, issuer, audience, `nonce`, expiry with 60 seconds of tolerance), then `decideSso` picks the person: linked `external_sub`, else the same verified email (then linked, `auth.sso_linked`; when that person has a password, the callback instead sets the 10-minute `__Host-ol_sso_link` cookie, an `sl1` envelope (`signSsoLink` in `packages/core/src/roles.ts`) holding the user id and subject, and redirects to `/login/sso/link`, which takes the account's password through `signInToLink` (the sign-in throttles; not refused under `ssoOnly`) and, without two-factor sign-in, links before starting the session (`auth.sign_in` with `method: "sso-link"`); with it, the two-factor page sends them back and the loader links once that person is signed in (`finishSsoLink`, only while `external_sub` is still null and no one else has the subject); a link that can't finish is audited as `auth.sign_in_failed` (`SSO link refused`)), else a new person when `jitRole` is set and the domain is listed (`team.user_added` with `via: "sso"`). Only `email_verified: true` keeps the email; a token without the claim keeps it only with `OIDC_TRUST_EMAIL` (Entra ID). The ID token must carry `exp`, `iat` and `sub`. It starts the same session as a password (`startSession`) and audits `auth.sign_in` with `method: "sso"`; a failure is `auth.sign_in_failed` with `method: "sso"` and a redirect to `/login?sso=failed`, `refused` or `disabled`. `/login/sso?reauth=1` from someone signed in is a step-up: it adds `prompt=login` and `max_age=0`, and the callback needs `auth_time` no earlier than a minute before the flow began and within the flow's ten minutes of the server's clock, keeps the session, and stamps `sessions.reauth_at` (`recordReauth`, audited `auth.reauthenticated`) only when the subject is the one linked to the signed-in person. With `ssoOnly` in effect (`ssoOnlyInEffect`: saved and a provider configured), `checkCredentials` and passkey sign-in refuse (`SSO only`), and `principal` no longer asks for two-factor setup or a password change from anyone (`passwordInUse`); someone with no password is never asked for two-factor sign-in either |
| `/scim/v2`, `/scim/v2/*` | `scimFetch` (`apps/web/app/lib/scim.server.ts`; shapes and parsers in `scim.ts`), after the OAuth paths and before the app. SCIM 2.0 provisioning for an identity provider. Each address first spends the `API_LIMIT` budget keyed `scim:<ip>`, so token guesses are bounded. It is authorised by its own bearer token, `ol_scim_…`, compared by SHA-256 with the `scim_token` workspace setting (no token set, or no match: `401` in SCIM's error shape), then spends the `API_LIMIT` budget keyed `scim`. `ServiceProviderConfig`, `ResourceTypes` and `Schemas` (empty) are discovery; `Users` and `Groups` support list (1-based `startIndex`, `count` up to 200, `eq` filters on `userName`, `externalId`, `displayName`, `id`; `excludedAttributes=members` on groups), get, `POST`, `PUT`, `PATCH` (Okta's and Entra's shapes) and `DELETE`. People are viewers without a password, keyed by email (`409` `uniqueness` on a duplicate). A new `userName` for someone with no `external_sub` who has a password, or a role above what `roleFromGroups` gives them (`emailLocked`), is refused with `400` `mutability`, since SSO would link that address to whoever the provider gives it. `active: false` or `DELETE` disables a person and revokes their sessions, OAuth grants and the `api_tokens` they created (`endAccess`, see [data model](data-model.md#people-and-tokens); matched by `created_by_id`, or for older tokens by the email they had before the change); the last active admin is refused with `409`. Group membership changes, group deletes and changes to the `scim_roles` map re-derive each affected member's role (`syncRole`: the highest mapped role, else viewer; unmapped groups change nothing; the last active admin is kept). Changes are audited with `via: "scim"`, by a `SCIM` token principal (or by the admin whose map change moved a role). `ScimStore` abstracts D1 so the protocol runs in memory in tests. `demo.server.ts` locks the path on demo deployments |
| `POST /login/passkey`, `POST /account/passkeys` | React Router action routes (JSON steps `options`/`verify`, and `options`/`add`/`remove`) for WebAuthn passkeys via `@simplewebauthn/server`; `apps/web/app/lib/passkeys.server.ts`. Internal to the web app, not part of the REST API. The RP ID and origin are the request's host; a verified passkey with user verification starts a session without a password or two-factor code |
| everything else | React Router (UI routes guard themselves with `requireUser(request, role)`). An HTML page without its own `cache-control` gets `private, no-cache` |

Before the API, agent and React Router branches, a browser request that changes state or opens a
WebSocket must pass `crossOrigin` (`apps/web/app/lib/origin.ts`), unless it is a REST call under `/api/v1/` with a bearer token (`bearerApiCall`; with one, `apiPrincipal` never reads the cookie): its
`Origin`, or failing that `Sec-Fetch-Site`, must show the app's own origin, or it gets `403`. See
[Cross-site requests](https://docs.orderloop.app/guides/team-and-roles/#cross-site-requests).

`apps/web/app/lib/auth.server.ts` resolves the principal: a `__Host-ol_session` cookie (a `sessions`
row, started by a password, a passkey or single sign-on) or a bearer token. `principal` looks a Request up once (a `WeakMap`), so the shell's and the page's loaders share it; a `.data` fetch, and the Request React Router gives loaders after an action, are new ones. The session's `last_seen_at`, a token's and a UCP platform's `last_used_at` are written after the response (`afterResponse`, `waitUntil`). With no `users` on localhost it is an open admin, which is the local dev default; on any other host `awaitingSetup` makes the Worker redirect browsers to `/setup` and answer everything else `503` until the first admin is created from the setup code (`setup.server.ts`). See [Team and roles](https://docs.orderloop.app/guides/team-and-roles/). The engine's own
`fetch` (`apps/engine/src/index.ts`) answers `/health` and routes agent requests; with
`workers_dev: false` and no routes it is reachable only through the binding. Its `email` handler
receives messages from Email Routing and hands them to `receiveEmail`; see
[Email intake](https://docs.orderloop.app/guides/email-intake/).

## REST API

The `/api/v1` routes are in `apps/web/app/lib/api.server.ts`. Request bodies in the OpenAPI
document (`apps/web/app/lib/openapi.ts`, served at `/api/v1/openapi.json` and rendered by the docs'
explorer) are generated from the zod schemas the handlers validate with
(`apps/web/app/lib/api-schemas.ts`), so they can't drift. Event payloads are capped at 32 KiB
(`MAX_EVENT_PAYLOAD_BYTES`, `packages/core/src/api.ts`); the OrderAgent's `deliver`, `decide` and
`cancel` enforce the same bounds on the live socket as the REST schemas do.

Outbound webhook subscriptions have a `rotate` route beside create and delete; it audits `webhook.rotated`.

Business events are audited at the first place that knows the actor: the web app's routes and API
handlers write them with `audit` (`apps/web/app/lib/audit.server.ts`), the engine writes them with
`recordAudit` (`apps/engine/src/audit.ts`) for the order socket (`via: 'app'`), the assistant, MCP
and A2A (`runAction`, A2A `place_order`; `tool` recorded). Both build the row with `auditRow`
(`packages/core/src/audit.ts`) into `audit_events` through `appendAudit` (`packages/db/src/audit.ts`), which seals each into a SHA-256 hash chain (`sealAuditRow`; `verifyAuditChain` checks it) and logs it as an `audit_event` line; the RPC callers' own rows are written by the
caller, so nothing is written twice. Replays and no-ops, email intake and the scheduled stock
review are not recorded.

## MCP

`/mcp` is the assistant's tools for MCP clients. The web Worker routes it, with the OAuth
discovery, registration and token paths, to `@cloudflare/workers-oauth-provider`
(`apps/web/app/lib/oauth.server.ts`). There it is one `OAuthAuthorizationServer` (issuer the
origin; resources `/mcp` and `/a2a`, with `/mcp` the default and the resource of grants made
before A2A) and one `OAuthResourceServer` per endpoint, which publishes
`/.well-known/oauth-protected-resource/<path>` with `scopes_supported: GRANTABLE_ROLES` (every
role but admin, which the provider also names as `scope` in the `401` challenge; the consent page
offers the same set) and accepts only tokens issued for it. The
authorization server does dynamic client registration, Client ID Metadata Documents, tokens of
1 hour (access) and 30 days (refresh), and keeps grants in KV `OAUTH_KV`. Only roles below admin are in `scopes_supported`. The consent page refuses a request without a PKCE `code_challenge` from any client (the provider requires it only of public ones). The provider rotates refresh tokens and still accepts the one before the current one. `refreshReuse`, before the provider sees a `refresh_token` grant, records the current token as spent when it is traded (`ol_spent:<sha256>`, 30 days, with when) and revokes the grant (audited `oauth.refresh_reused`, and the app's A2A push configs dropped) when any spent token comes back, except the previous one within `REFRESH_GRACE_MS` (a minute) of when it was traded, which a retry doesn't extend. A token traded before this was recorded is left to the provider. Two processes sharing one client's credentials and refreshing apart trip it too. `forward` adds the grant id (from the token) and client id to the signed principal (`grant`, `client`), and MCP and A2A actions put both in their audit detail. A2A push deliveries use `redirect: 'manual'` and count a 3xx as a failure. `/login` names a waiting app only for a registered client id, never fetching a URL one. The consent page is `routes/oauth-authorize.tsx`; the grant's `props` are
the approver and the role they chose. A bearer that is not an issued
token (one not shaped `<user>:<grant>:<secret>`) is checked as an `ol_live_` token by
`apiPrincipal`, with its expiry (anything else is `401`), on either endpoint.

`forward` refuses a malformed `Origin` (`badOrigin`: present and not `http`/`https`) and accepts any other on purpose: every request carries a bearer token and cookies are deleted, so DNS rebinding, the case the MCP Origin rule guards, gains nothing. It then resolves the caller (for a grant, `scopedGrant` first lowers the grant's role to the lowest role the token's own scope names, `ctx.auth.scope`, so a narrowed token acts with less and one that names no role gets `403 insufficient_scope`; then `grantPrincipal` re-reads the person: disabled means
refused, and the role is the lower of granted and current), refuses a pending two-factor setup,
deletes `authorization` and `cookie`, signs the caller into `x-orderloop-principal` for that path (`setPrincipalHeader`, `PRINCIPAL_KEY`) and fetches the engine over the
`ENGINE` binding. The engine's `fetch` and `EngineApi.fetch` hand `/mcp` to `handleMcp`
(`apps/engine/src/mcp.ts`): `createMcpHandler` from `@modelcontextprotocol/server` (`legacy: 'stateless'`), a fresh
`McpServer` per request, no session: 2026-07-28 requests carry their envelope, and 2025-era ones
are served statelessly. It registers only the
`ASSISTANT_TOOLS` the role allows, with `TOOL_INPUTS`, `TOOL_OUTPUTS` (loose zod objects, served as
`outputSchema` and checked by the SDK) and `runTool` from `assistant/tools.ts`, the code the
assistant runs too, and passes `via: 'MCP'` so `runAction` records `<email> via MCP`. Hints come
from `DESTRUCTIVE`, `IDEMPOTENT` and `OPEN_WORLD` in `mcp.ts`; `tools/list` carries a private
60-second cache hint on 2026-07-28. A `Refused` is the tool error the model reads; any other throw
is logged and answered with a generic tool error, so database or provider messages never reach the
client. `assess_order` and `propose_flow_change` send one progress notification when the request
has a progress token.

An action tool (`isActionTool`: `decide_approval`, `deliver_event`, `cancel_order`, `submit_cart`,
`publish_flow`, `run_stock_review`) never runs on the first call, because a client may not ask its person. When
the request is 2026-07-28 and its envelope's client capabilities declare form elicitation
(`canElicit` in `mcp.ts`), the first call returns `inputRequired` with a `confirm` elicitation
built from `previewAction`, and the `cfm_…` code from `issueConfirmation` as `requestState`.
The retry runs only when `acceptedContent(…, 'confirm', CONFIRM)` is `confirm: true` and
`useConfirmation` accepts the returned state, which the SDK does not verify: the D1 row is what
binds it to the principal, tool and input, once. The elicited code is issued and used for the
input plus `ELICITED` (a key input schemas strip, so callers can't send it), so it is never
accepted as a `confirmation` argument and a two-call code is never accepted as request state; a
`confirmation` on a request that can elicit is refused, and a declined answer uses the code up.
The elicitation message is a fixed line naming the tool, then the preview lines through
`boundText`. Otherwise the two-call code flow below applies. Its
schema gains an optional `confirmation`, and its description and the server `instructions` say to
show the preview first. Without a code, the handler returns `previewAction` (the assistant's confirm
card; a blocked preview is a tool error), a `cfm_…` code from `issueConfirmation`
(`apps/engine/src/confirmations.ts`), `expiresAt` and `next`, and changes nothing. With one,
`useConfirmation` must pass before `runTool`: a single `UPDATE` on D1 `action_confirmations` matching
the principal, the tool, `fingerprintOf({ tool, input })`, unused and within
`CONFIRMATION_TTL_MS` (5 minutes). Anything else is a tool error. The sweep calls
`pruneConfirmations`. A2A typed skills and `place_order` call `runTool` directly (the caller composed
the call, as with REST, `confirmed: 'direct'`); A2A chat has its own `{ confirm }`.

A preview can also carry `bound`: what the person is shown that can change before they confirm
(for `submit_cart`, `{ cartVersion }`, since `change_cart` needs no confirm). The channel that
showed the preview keeps it and strips it from what it sends: MCP in the code's `bound` column
(`issueConfirmation`, handed back by `redeemConfirmation`), the assistant panel in the
`AssistantAgent`'s storage per tool call (the card passes its `toolCallId` to `preview()`; the
first look writes it with the input's digest, a later look that sees another version or input
marks it stale and returns the card blocked, the confirmed `execute` uses it up through `shown`,
and declined cards' entries and day-old ones are pruned), A2A chat with the task's pending action. `runAction` passes it on as `confirmed`, and
`runSubmit` hands `cartVersion` to `CartAgent.submitAs`, which refuses a cart whose version moved
on (`CART_CHANGED_SINCE_CONFIRM`); a submit with no bound, other than a typed A2A skill, is refused
too. A typed A2A `submit_cart` (`'direct'`) is held only to the `cartVersion` its input names, and
REST `POST /api/v1/carts/:id/submit` to a body `version` or `If-Match` (the ETag `GET` serves),
answering `412` when the cart moved on; both reach `CartAgent.submitAs` through
`EngineRpc.submitCart(cartId, actor, version)` or `runSubmit`. A2A skill tags come from
`isWriteTool` (an action or one of `WRITES_WITHOUT_CONFIRM` in `packages/core/src/assistant.ts`,
which `mcp.ts` also reads for `readOnlyHint`). See
[MCP server](https://docs.orderloop.app/reference/mcp/).

Skills: `createServer` attaches the role's `SkillCatalog`
(`@modelcontextprotocol/server/ext/skills`, built once per isolate per role from
`mcpSkillFiles(role)`, `MCP_SKILLS` in `packages/core/src/mcp-skills.ts`), which declares
`resources` and `io.modelcontextprotocol/skills` and serves `skills/list`, `skills/get` and
`resources/read` on `skill://<name>/SKILL.md` with SHA-256 digests and a private five-minute cache
hint. The catalog also declares `directoryRead` and answers `resources/directory/read` for skill
folders. The extension is declared to every revision, so 2025-era clients can list and read skills
as well. A skill is offered to roles at or above its `role`;
`tests/mcp-skills.test.ts` in core checks every tool it names exists and is within that role.

## A2A

The Agent Card at `/.well-known/agent-card.json` is built from the request's origin by `agentCard`
(for an `A2A-Version: 1.0` request) or `legacyAgentCard` (the 0.3 shape, for anyone else) in
`packages/core/src/a2a.ts`. Push
notification URLs pass `isWebhookUrl` (`packages/core/src/webhooks.ts`), the same rule as outbound
webhook subscriptions.


`/a2a` is the same tools, plus `place_order` and `chat`, for Agent2Agent clients. `forward` is the
same function as for MCP, aimed at `/a2a`. The engine's `fetch` and `EngineApi.fetch` hand it to
`handleA2A` (`apps/engine/src/a2a/route.ts`), which sends it to
`a2aAgent(env, a2aCaller(p))`: `<kind>:<id>`, and `:<grant>` for a connected app (the forwarded principal names its OAuth grant and client), so each caller, and each app one person connected, has its own `A2AAgent` Durable Object
(`agent.ts`, migration `v3`). A 0.3 method name (`message/send`, …) goes to the SDK's
`LegacyJsonRpcTransportHandler`; otherwise it checks the `A2A-Version` header (absent means 1.0).
Both run JSON-RPC through the same `@a2a-js/sdk` `DefaultRequestHandler`, with SSE for `SendStreamingMessage` and
`SubscribeToTask`. `SqlTaskStore` (`store.ts`) keeps tasks in `tasks` and the order a task follows
(or a chat action waiting for a confirm) in `task_links`; for an unfinished order, `load` and
`list` take the status from the `OrderAgent` snapshot through `orderTaskState` in
`packages/core/src/a2a.ts`. `OrderLoopExecutor` (`executor.ts`) reads a data part
`{ skill, input }` into `runTool` with `via: 'A2A'`, starts orders with `startOrderOnce` keyed
`a2a:<principal id>:<messageId>`, runs `chat` with `assistantModel` (an action it proposes stops at
`input-required` until `{ confirm }`), and follows an order for up to 25 seconds per request.
`CancelTask` cancels the order first, as the caller.

Push notifications (`push.ts`) keep their configs in `push_configs` and a durable outbox in
`push_outbox` in the same SQLite, retried on the object's alarm. A config's `token` and
`auth_credentials` and a queued notification's `headers` are stored encrypted under `DATA_KEY`
(`apps/engine/src/data-key.ts`), bound to their row; a config is resealed when loaded, and one sealed
under a key the deployment no longer has is dropped (logged) so the caller registers again. Updates that happen with no
request open take a second path: `SqlTaskStore.follow` calls `OrderAgent.watch(<A2AAgent name>)`,
the `OrderAgent` schedules `notifyWatchers` when its status or waits change, and that calls
`A2AAgent.orderChanged(orderId)`, which re-reads each following task and pushes the ones that
changed. Neither it nor the outbox's retry alarm sends anything once the agent's owner (its name, `a2aCaller`) is a disabled person or a revoked or expired token (`stillActive`, `apps/engine/src/principal.ts`; any kind but `user`, `token` or `open` counts as inactive); the alarm then drops what is queued. `EngineRpc.dropA2aPushes(kind, id)` (`A2AAgent.dropPushes`) forgets every push config and pending push of that caller, which the web app calls whenever a person's connected apps are ended. See [A2A endpoint](https://docs.orderloop.app/reference/a2a/#push-notifications).

## UCP (agentic checkout)

`/.well-known/ucp`, `/ucp/v1/*` and `/ucp/mcp` let AI shopping platforms buy from the workspace over
the [Universal Commerce Protocol](https://docs.orderloop.app/reference/ucp/) (`UCP_VERSION`
`2026-08-25`). The protocol lives in core: `packages/core/src/checkout.ts` is the protocol-neutral
checkout session (`CHECKOUT_STATUSES`, `missingInfo`, `openStatus`, `quoteNodes`,
`checkoutFlowProblem`) and `packages/core/src/ucp/` is UCP over it: profile and negotiation
(`profile.ts`, `ucpSettingsSchema`), checkout and order mappers (`checkout.ts`, `order.ts`), RFC 9421
message signatures (`signature.ts`, ES256 and `Content-Digest`), RFC 8941 structured fields
(`structured.ts`) and error shapes (`errors.ts`). All of it is pure and tested against the official
schemas. The engine serves it from `apps/engine/src/ucp/`.

**Boundary.** A platform is not a `Principal`: it has no role and acts only on its own checkouts
and orders. The web Worker (`ucpFetch`) finds it by key (`X-API-Key` or `Bearer`, `ol_ucp_` and the
SHA-256 in `ucp_platforms.key_hash`, revoked rows excluded), requires `UCP-Agent` to equal the
registered `profile_url` (MCP may omit the header; the engine checks `meta["ucp-agent"]` against the
same profile), answers `404` while `checkoutFlowId` is unset (`ucpSettings`, kept 30 seconds per isolate; the admin API reads it fresh), spends the `AGENT_LIMIT` budget per
platform (`/ucp:<platform id>`), deletes `authorization`, `x-api-key` and `cookie`, and signs a
`PlatformCaller` onto `x-orderloop-principal` with `signPlatform`. That is a separate envelope
(`u1`, not `v1`) over the same key, path and 60-second expiry, so `verifyPrincipal` never accepts it
and `verifyPlatform` never accepts a principal: a platform's header is refused at `/mcp`, `/a2a` and
the sockets, and a person's at `/ucp`. The engine's `handleUcp` (`rest.ts`) believes only that
header. The engine does not import web code; the web Worker reaches the profile through
`EngineRpc.ucpProfile(origin)`.

**Discovery.** `ucpProfile` (`config.ts`) builds the business profile for the request's origin:
services, `UCP_CAPABILITIES`, the payment handlers (`paymentHandlers`: `app.orderloop.stripe` with
`PAYMENTS_MODE` `stripe` and `STRIPE_PUBLISHABLE_KEY`, else `app.orderloop.test` in `mock`) and the
public half of `UCP_SIGNING_KEY`. It is public, `cache-control: public, max-age=300`, and `404` (max-age 60)
while off. The platform's own profile is fetched by `platformProfile` (`platform.ts`): https only,
`redirect: 'manual'`, 5 seconds, 128 KB, stored in `ucp_platforms.profile` and reused for an hour. A
failure is `424 profile_unreachable` or `422 profile_malformed`; `negotiate` then intersects the capabilities
(`version_unsupported` is `422`, an empty intersection a `200` error response).

**Quote parity.** `quoteCheckout` (`quote.ts`) prices a session with the checkout flow's own executors:
`quoteNodes(graph)` picks the `QUOTE_NODE_TYPES` nodes (`commerce.validate`, `price`, `shipping_rate`,
`tax`, `policy`) in the order the flow reaches them and runs `EXECUTORS` on a draft order, in
process, on the flow's latest published version. Those executors only read, so a quote writes
nothing. The order the flow later runs prices the same lines the same way, so the hold placed at
completion matches the total the order's authorize node adopts. Sessions are priced again on every
write and once more right before completing. A session is a row in `checkout_sessions` (the JSON in
`data`, `version` compared on every write: a loser gets `409 conflict`).

**Completing.** `completeCheckout` (`checkout.ts`) is under an `Idempotency-Key` (`once`,
`idempotency.ts`; `ucp_idempotency`, 24 hours, a throwing request releases its key). It reprices, claims the
session (`complete_in_progress`) and calls `authorizeCheckout` (`payments.ts`): for Stripe a PaymentIntent
with `capture_method: 'manual'`, `confirm: true` and `allow_redirects: 'never'`, keyed
`ucp_<session>_<pm>_<amount>` so a retry replays the same hold; a PaymentIntent that is not
`requires_capture` (3-D Secure, processing) is canceled and reported as `payment_failed`. The hold goes
into the order input as `payment: { provider: 'stripe', intentId }`, and the order's
`commerce.authorize_payment` node adopts it (the `adopt` source in `packages/core/src/payments.ts`; see
[Payments](https://docs.orderloop.app/guides/payments/)). The order starts with `startOrderOnce` keyed
`ucp:<session id>`, `channel: 'agent'`, `startedBy` the platform id and `meta.ucp = { platformId,
checkoutId, origin }`. If starting it throws, the hold is released (`releaseHold`).

**Order events.** `OrderAgent` sees `meta.ucp` on its order and, after a state change settles,
queues `ucpSync` (2 seconds, table `ucp_sync`: `digest`, `pending`, `released`). `syncUcpOrder`
(`webhooks.ts`) builds the full `toUcpOrder` entity (`orderEntity`), skips it when its digest equals the
last delivered, and otherwise POSTs it to the order capability's `config.webhook_url` from the cached
platform profile, signed with `signMessage` (`@method`, `@authority`, `@path`, `content-digest`,
`content-type`, `ucp-agent`) and the `UCP_SIGNING_KEY` `kid`, with `Webhook-Id` and `Webhook-Timestamp`.
A failure that is worth retrying is rescheduled with `10 * 2^attempt` seconds up to `WEBHOOK_RETRIES`.
Nowhere to send (revoked platform, no `webhook_url`, no order capability, no signing key) is not retried.
The same `ucpSync` releases a hold no step took once the order ends `cancelled`, `declined`, `failed` or
`rolled_back` (`UNFULFILLED`).

**MCP.** `/ucp/mcp` (`mcp.ts`) answers JSON-RPC itself instead of through the MCP SDK because UCP fixes
the error shape: a protocol error is a JSON-RPC error (`-32001` for `422` and `424`, `-32000` otherwise,
with the HTTP status) and a business outcome is a result with `structuredContent`. The six tools call
the same operations as REST.

The retention sweep prunes `ucp_idempotency` after 48 hours and abandoned `checkout_sessions` 30 days after
they expire (see [Retention](data-model.md#retention)). Audit actions `ucp.settings`,
`ucp.platform_added` and `ucp.platform_revoked` (group `ucp`, "Agentic checkout") are written by the
admin API (`/api/v1/ucp`, `handleUcpAdmin` in `api.server.ts`), which refuses a flow that
`checkoutFlowProblem` rejects; demo mode locks `/api/v1/ucp`.

## Secrets at rest

Secrets the deployment stores are encrypted with `encryptSecret` (`packages/core/src/encryption.ts`):
AES-256-GCM under a key HKDF-SHA256 derives from `DATA_KEY`, stored as `e1.<key id>.<iv>.<ciphertext>`
(base64url). The key id is derived from the key, so `DATA_KEY_PREVIOUS` can still be read during a
rotation. Each value is bound to its row as AES-GCM associated data (`secretContext`), so a
ciphertext copied elsewhere doesn't open. A value without the prefix was stored before encryption
and is read as it is. Covered: `users.totp_secret`, the `secret` and `previous_secret` of
`integrations` and `webhook_subscriptions`, and the A2A push configs' credentials and queued headers
(see [A2A](#a2a)). The web app seals and opens with `sealSecret` and `openSecret`
(`apps/web/app/lib/data-key.server.ts`; in dev an unset key falls back to `DEV_DATA_KEY`, elsewhere it
throws), the engine with `apps/engine/src/data-key.ts`, whose `resealSecrets` the daily retention
sweep calls. See [Rotating the data key](operations.md#rotating-the-data-key).

The outbox opens a subscription's secrets when it sends (`signingSecrets`, `apps/engine/src/outbox.ts`).
`POST /api/v1/webhook-subscriptions/:id/rotate` (`rotateSubscription`, `apps/web/app/lib/webhooks.server.ts`)
seals a new secret and moves the old, still sealed, to `previous_secret` with `previous_expires_at`
`ROTATION_GRACE_MS` (24 hours) away; until then `signWebhook` receives both and the
`X-OrderLoop-Signature` header carries a `v1=` for each. A secret no key opens fails that delivery
(retried like any other), not the step.

## Product catalog

`orderloop-catalog` (`apps/catalog`) is the write side of a product catalog, and
`orderloop-catalog-edge` (`apps/catalog-edge`) the read side. The pure model lives in
`@orderloop/core/product`; the catalog Worker adds storage and publishing. It has no routes, no
`workers_dev` and no preview URLs: it answers `GET /health` and `404` otherwise, and its callers
reach it through service bindings. The web app binds its `CatalogApi` entrypoint as `CATALOG` and
forwards `/api/v1/catalog/*` to it ([Catalog admin API](#catalog-admin-api)); it is the only
writer. `catalog-edge` shares its R2 bucket, KV namespace
and purge queue with it and binds its `SearchApi` entrypoint for keyword search (see
[Catalog edge](#catalog-edge)); every other read path never touches a Durable Object.

`CatalogApi` (`apps/catalog/src/api.ts`) is a `WorkerEntrypoint` implementing `ProductCatalogRpc`
(`packages/core/src/product/api.ts`). It never touches storage itself:

| Method | What it does |
|---|---|
| `putProducts(items, opts)` | At most 500 a call (`RangeError` over). Validates each against the type it names (`validateProduct`), reports a bad one as `rejected` with every issue beside the valid ones, groups the rest by `productShard(key)` and sends each shard one `apply` batch with a fresh batch id |
| `deleteProducts(keys, opts)` | At most 500; one `remove` call per shard |
| `getProduct`, `resolveAlias` | Read a product from its shard; read which product key holds a SKU, GTIN or slug from the alias's shard (`aliasShard`). A GTIN is looked up as its GTIN-14 (`claimedAlias`), so any length finds it, and an invalid one finds nothing |
| `putType`, `deleteType`, `listTypes` | Product types, through `CatalogMeta`. `deleteType` sums `CatalogShard.countUsing({ type })` over all 64 shards and refuses with `N products use <code>: delete or move them first`; else `CatalogMeta.deleteType` removes every version (`<code>: unknown type` when there were none) |
| `putChannel`, `listChannels`, `putCategories`, `listCategories` | Channels and categories, through `CatalogMeta`. The writes answer with a `Result` (`{ ok: true, … }` or `{ ok: false, issues }`), as `putType` does |
| `deleteChannel(code, by)` | `CatalogMeta.deleteChannel` first (the channel leaves the config, so no shard publishes to it again, and its category trees are deleted from R2; `<code>: unknown channel` when absent), then every shard runs `forgetChannel(code, 500)` until it answers 0: it deletes the channel's documents, alias pointers and `CARDS` entries for the `published` rows, sends `ListingChange`s with `entry: null`, `left` the categories and `search: null` (so the indexers and search shards drop them), and clears the rows. Last it sweeps the R2 prefixes `idx/f1/<code>/` and `docs/f1/<code>/`. Answers `{ ok, code, unpublished }`. Products keep their listing data, so re-adding the channel and a `reindex` republishes it |
| `deleteCategories(codes, by)` | Refuses with `<code>: N products are filed in it` (counted over the shards by `countUsing({ category })`), or when `CatalogMeta.deleteCategories` does (`unknown category`; `<parent>: still the parent of <child>` for a child outside the set). Otherwise deletes them, republishes the tree in every channel and deletes every segment of their `idx/` listing in every channel. Answers `{ ok, deleted }` |
| `startFeed(body, { name, format, by })` | Streams the file into R2 (`feeds/<id>/source.<format>`, `storeStream` in `upload.ts`: one `put` up to 10 MiB, else a multipart upload in 10 MiB parts, so memory holds one part; a body that sends nothing for `UPLOAD_IDLE_MS` (30 s) is cancelled, its multipart upload aborted and `UploadStalled` thrown, rather than hanging until the runtime cancels the request), then records the feed in `CatalogFeeds` as `queued` and starts the `FeedImport` Workflow with the feed id as its instance id, both under `ctx.waitUntil` so a caller that disconnects after the upload can't leave a queued feed with no Workflow (and a Workflow that fails to start marks the feed `failed`), and returns the `FeedStatus`. A `format` other than `csv` or `ndjson` throws `RangeError`. See [Feed import](#feed-import) |
| `cancelFeed(id, by)` | `CatalogFeeds.cancel` moves a `queued`, `splitting` or `applying` feed to `cancelled` (with `cancelledBy` and `finishedAt`), then terminates its `FeedImport` instance, ignoring an instance that never started or has stopped. Returns the `FeedStatus` (unchanged for a finished feed), `null` for an unknown id |
| `feedStatus(id)`, `listFeeds(limit)` | A feed's `FeedStatus` (`null` for an unknown id), or the most recent feeds first (20 by default, between 1 and 100) |
| `reindex(by)` | Calls `republishAll` on all 64 shards, which queue every product not already waiting in their `outbox` for the publisher (so repeating it queues nothing twice), and answers `{ queued }`, the number of products on the shards. It waits for no publishing: each shard's alarm does that |

The isolate keeps a copy of the config (every type version, every channel, the `rev` counter) for 2
seconds. A product that names a type this copy lacks refreshes it once before being refused, and
`putType` and `putChannel` drop it. A product without a type version is pinned to the latest the
isolate has seen, which is always valid because versions only add.

**`CatalogShard`** is the source of truth: 64 SQLite Durable Objects named `shard-<n>`, `n` from
`productShard(key)` (frozen: a change strands stored products). A shard holds three things in one
database: its products (`products`, with a per-shard `uid` from `productUid`, a content `hash` and
a `version` that starts at 1 and counts changes), the alias claims that hash to it (`aliases`, so a
SKU, GTIN or slug is unique without a global object) and the `outbox`.

- `apply(batch)` is idempotent by `batchId`: the first call's results are stored in `applied` and a
  repeat returns them without writing. A row whose content hash matches what is stored is
  `unchanged` and writes nothing, so a daily full feed is cheap. A key repeated in a batch keeps its
  last row; the earlier ones are `rejected`. A shard refuses to be called as a different shard number.
- New aliases are claimed on their owning shards before the write transaction, never inside it and
  never while holding the input gate, so two shards claiming from each other can't deadlock. A
  claim another live product holds rejects the product with `already used by <key>`. A claim whose
  holder no longer lists the alias (a release that failed) is taken over. The transaction re-checks
  what it read: a product changed by another write meanwhile is rejected with `send it again`, and
  what it claimed is given back. Aliases a product dropped are released after the commit, best effort.
- Each change writes an `outbox` row in the same transaction. The shard's alarm publishes from it
  (`publish.ts`), up to 100 products a pass (`PUBLISH_BATCH`) and up to four passes in flight at
  once (`PUBLISH_PASSES`), each on different products: a new pass starts as soon as one finishes,
  rather than after the slowest write of the last. A product whose pass is in flight is left for a
  later pass (`nextPass` skips it), so its writes never overlap. An alarm keeps starting passes for
  a minute (`ALARM_WINDOW_MS`), then sets itself again while rows remain, so a crash between storing
  and publishing only delays publishing. A failed pass fails the alarm, which is retried, once the
  passes still in flight are done.

**Publishing** renders each product once per channel and locale (`renderForChannel`) and writes:
a product document and alias pointers to R2 (`PUBLISHED`, under `docs/f1/<channel>/…`, `f1` being
`DOC_FORMAT`; every path carries it so a format change is a new tree) and a listing card to KV
(`CARDS`, `c:f1:<channel>:<locale>:<uid in base 36>`). Slug aliases are published only in the
channel's locales. What was published before and no longer is (a draft, a channel that no longer
lists it, a dropped locale, SKU or variant, a deleted product) is deleted. Which locales and
aliases are published per product and channel is kept in the shard's `published` table. Before a
pass writes anything, each row is recorded as the union of what was published and what the pass
will publish; once every write has succeeded it is recorded exactly. A pass that fails partway
therefore leaves a row covering whatever it may have stored, so the next pass for that product takes
it down even if the product was deleted in between (before this, the deleted product's cards and
documents could outlive it). A failed pass republishes in full. Cards are keyed by uid: when a
deleted key is created again before its delete published, it has a new uid and every card under the
old one is deleted, in every locale. Publishing the
same product twice writes the same bytes. `publishKeys` also returns a `ListingChange` per product
and channel it touched: `{ channel, key, at, rev, entry, left }` (`rev` being the config revision it published with), where `entry` is what the product lists
as now (`null` when it no longer lists in the channel) and `left` the categories it was published in
before, which the `published` row's JSON now keeps beside `uid` and `aliases`. `search` is what
keyword search indexes, one `SearchEntry` (`title`, `brand`, `skus`, `body`) per locale, or `null` when
the product no longer lists in the channel. See [Listing indexes](#listing-indexes) and
[Keyword search](#keyword-search).

The shard renders and plans the writes but does not do them. A Workers invocation, a Durable
Object alarm included, can have only six storage calls waiting for response headers at once (R2, KV
and Queues calls all count, and a write's headers arrive when it is stored), so one shard's alarm
alone published only a few products a second. `publishKeys` builds each write as a `WriteOp`
(`publisher.ts`: an R2 or KV put, or an R2 or KV delete, as plain data that crosses RPC) and groups
them by `publisherOf(key, PUBLISH_FANOUT)`, the FNV hash of `w:<key>` modulo the fanout (default 32).
Each group goes to `CatalogPublisher` `pub-<shard>-<n>` (`publisher()` in `config.ts`, scoped to the
jurisdiction like the other objects), whose `write(ops)` starts them all at once through `runOps` (the runtime
queues those past six and starts each as a slot frees, so none waits for a slower one).
`publishKeys` awaits every publisher and only then records `published` and returns the changes. With
a fanout of 1 it runs the ops itself and makes no hop. One product's writes always go to the same
publisher and the product is in no other pass until every publisher of its pass is done, so a
product's writes are never reordered. The publishers hold no state.

Measured on production in October 2026 (a pass is 100 products, about 500 writes):

- With no publishers, a 250,000-product feed published at about 200 products a second across the 64
  shards (an alarm pass's p99 about 18 seconds, CPU about 1%).
- With 8 publishers each running 16 writes in lockstep, a 750,000-product feed still published at
  about 240 a second. A publisher's call (about 62 writes) took 10 seconds at the median, so a write
  took about a second from the publisher, while R2 and KV accepted about 1,200 writes a second with
  no errors. The listing changes queue kept up throughout (backlog under 250 messages, 2 to 8
  consumers).
- With 32 publishers starting every write at once, republishing 1,000,000 products peaked near
  1,000 a second (R2 about 3,200 puts a second) and averaged about 400. A pass waited for the
  slowest of its 32 publishers (shard pass p50 8 to 14 s), which is why passes now overlap.

Publishing also writes the product's `uid` entry to KV (`u:f1:<key>`, `paths.uid`) the first time
the product publishes in any channel, and again when the key's uid changed (a key deleted and
created again), which is how `catalog-edge` finds cards by key. Publishing a deleted product deletes
the entry, so the batch lookup can't reach a card through a uid that is gone. After the alarm has published a pass, it sends the cache tag `p:<key>` of every product whose
outbox rows were `urgent` to the `PURGE` queue (`PurgeMessage`: `{ tags }`), up to 100 tags a
message (what one purge call takes), in one `sendBatch`. It sends after publishing so a purge never
refills the cache from the old document.

Outbox rows also carry `rev`, the config revision the write was validated against (null for a
removal or a reindex), and `forced` (set by `republishAll`). Both columns were added after the
table, so the constructor adds them when missing (`ALTER TABLE … ADD COLUMN`), and indexes
`outbox(key)` and `applied(at)` with `CREATE INDEX IF NOT EXISTS`. The alarm calls
`loadConfig(max rev)`, which reuses the shard's copy of the config unless it is older than that
revision or than 2 seconds, and fetches the latest from `CatalogMeta` when any row has no revision.
Every alias pointer is written on every publish, even one the product already published: when an
alias moves between products on two shards, the old owner's later publish can delete the new
owner's pointer, and the new owner's next publish puts it back. A `forced` row (a reindex) is marked
`forced` on its listing changes, so its listings rebuild even when no entry changed. A write reads each stored row's `version`
and `hash` first and parses the stored body (for the old aliases) only for rows whose hash changed.
The pass's listing changes go to the `CHANGES` queue first (`sendChanges`: packed into messages of up to
`CHANGES_MESSAGE_BYTES`, 64 KB, so a consumer batch of 100 messages holds thousands of changes and a
root category takes one call for them, not one per hundred), before the outbox rows
are deleted, so a crash between the two republishes and sends them again.

### Catalog admin API

`/api/v1/catalog/*` is the web app's front for `CatalogApi` (`apps/web/app/lib/catalog-api.server.ts`,
`handleCatalog`, dispatched from `handleApi` in `api.server.ts`). `catalog()` in `env.server.ts` types
`env.CATALOG` as `ProductCatalogRpc`. The web app never imports catalog source and checks only the
shape of what it forwards; the catalog validates products against their types, which the web app
doesn't hold. Roles: reads `viewer`, writes `operator`, `reindex` `admin` (`atLeast`, `403` with
`forbidden(min)`). Every write is audited with `via: 'api'`.

| Route | Calls | Notes |
|---|---|---|
| `GET products/:key` | `getProduct` | `{ product }`, `404` when unknown |
| `POST products` | `putProducts` | `{ products, urgent? }`, 1 to 500 (`catalogProductsInput`), body read up to 8 MiB; `{ results }`. Audit `catalog.products_written` with the counts and `urgent` |
| `POST products/delete` | `deleteProducts` | `{ keys, urgent? }`, 1 to 500; `catalog.products_deleted` |
| `GET aliases/:alias` | `resolveAlias` | `{ key }` or `404` |
| `GET`/`POST types` | `listTypes`, `putType` | A refused type is `409 { error: 'Type refused', issues }`; `201 { type }`; `catalog.type_saved` (target the code, detail `version`) |
| `GET`/`POST channels` | `listChannels`, `putChannel` | `400` when refused; `catalog.channel_saved` |
| `GET`/`POST categories` | `listCategories`, `putCategories` | `{ categories }`, 1 to 500; `catalog.categories_saved` |
| `DELETE types/:code` | `deleteType` | `operator`; `{ ok, code, versions }`; `catalog.type_deleted` (target the code, detail `versions`) |
| `DELETE channels/:code` | `deleteChannel` | `admin`, since it takes a storefront's catalog down; `{ ok, code, unpublished }`; `catalog.channel_deleted` (detail `unpublished`) |
| `POST categories/delete` | `deleteCategories` | `operator`; `{ codes }`, 1 to 500 (`catalogCategoriesDeleteInput`); `{ ok, deleted }`; `catalog.categories_deleted` (detail `codes`) |

A refused delete is `404 { error: 'Not found', issues }` when the catalog answers `notFound: true` (nothing by that code), else `409 { error: '<The type|The channel|A category> is in use', issues }`. `deleteChannel` takes the channel's content down even when the channel is already gone from `CatalogMeta`, so a delete cut short finishes on a retry; it answers `notFound` only when the channel is unknown and nothing was left to take down.
| `POST feeds?format=&name=` | `startFeed` | `format` is `csv` or `ndjson` (`FEED_FORMATS`), else `400`. The request body is passed to the catalog as a stream, so a feed of any size never sits in the Worker; `name` defaults to `feed.<format>` and is cut at 200 characters. `202 { feed }`; `catalog.feed_started` (target the feed id), written after the response so it is kept even if the caller disconnects. `408` when the catalog gave up on a body that stopped arriving (`upload stalled`; nothing was stored) |
| `POST feeds/:id/cancel` | `cancelFeed` | `operator`; `{ feed }`, `404` when unknown, `409 { error, feed }` when the feed had already finished (`done` or `failed`); `catalog.feed_cancelled` (target the feed id) |
| `GET feeds`, `GET feeds/:id` | `listFeeds(limit)`, `feedStatus` | `limit` defaults to 20 |
| `POST reindex` | `reindex` | `202 { queued }`; `catalog.reindexed` |

The `catalog.*` actions are in `BUSINESS_AUDIT_ACTIONS` (`packages/core/src/audit.ts`) and the web
audit filter group is `catalog` (`AUDIT_GROUPS` in `apps/web/app/lib/audit.ts`, label "Catalog"). The
OpenAPI document (`openapi.ts`) lists these paths, with request bodies from the zod schemas in
`api-schemas.ts`, which re-export core's `productTypeSchema` and `channelSchema` as the type and
channel bodies.

### Order Loop's products

The catalog also keeps its half of the D1 `products` table (`apps/catalog/src/orders.ts`), through the
catalog's own `DB` binding (the same database as the web app and engine; the migrations stay the web
app's). Only one channel feeds it, `ORDERS_CHANNEL` (variable, default `web`), and only when that
channel's currency is `BASE_CURRENCY` (`USD`), the currency of an order's list prices.

1. `publishKeys` adds `order: orderLines(product, type, channel)` to the `ListingChange` of the
   orders channel when the product has a type and renders there (is active, visible, with an active
   variant). `orderLines` returns one `{ sku, name, price, weightKg, lengthCm, widthCm, heightCm }` (the
   weight and size null when the variant has none) per active variant with a price in
   `BASE_CURRENCY`: the variant's `prices.<channel>`, else the listing's `price`. The name is the
   title in the channel's default locale, plus the variant's axis option labels in parentheses
   (`Field jacket (S)`); the price is `fromMinor`, a decimal. A product that no longer lists carries
   no `order`, so nothing is written or deleted: **a product that stops being listed keeps its rows**,
   because orders may name its SKUs.
2. The changes queue consumer runs `applyOrders` beside `applyChanges` and `applySearch`. It keeps the
   newest change per SKU in the batch and upserts in batches of 100: `INSERT … ON CONFLICT (sku) DO
   UPDATE SET name, price, catalog_at, weight_kg, length_cm, width_cm, height_cm WHERE catalog_at IS
   NULL OR catalog_at < excluded.catalog_at`. The weight and size are set as sent, so a variant that
   loses them clears the row's.
   `catalog_at` is the change's `at`, so a change that arrives late, as queue delivery allows, never
   overwrites a newer one. A new row has `cost` 0 and takes the column defaults (no stock, `kind`
   `physical`); an existing row keeps `cost`, `stock`, `reserved`, reorder settings, `supplier`,
   `seller_id` and `kind`.

The engine, pricing and replenishment read `products` exactly as before. Rows the catalog never wrote
have a null `catalog_at`. See [Data model](data-model.md#product-catalog).

### Listing indexes

A category page is answered from `LISTING_SEGMENTS` (8) binary blobs per channel and category, built
by the catalog and read by `catalog-edge` (format, builder and the merged query in
`packages/core/src/product/listing-index.ts`). A product's key picks its segment
(`listingSegment(key)`, FNV-1a of `l:<key>` mod 8, in `routing.ts`), the same in every category, and
each segment has its own indexer and its own blob, so no single build or object grows with the whole
category. The count and the hash are frozen by the golden tests in `product-routing.test.ts`:
changing either strands every built segment and needs a full listing rebuild (a `reindex`).

Why segments: on production's 1M-product scale test, one indexer holding the root category (all 1M
members) took 30 to 36 seconds per rebuild (alarm p99). From about 600,000 members the change
batches queued behind the rebuild until the object refused them (`Durable Object is overloaded`,
292 errors), and at about 900,000, with changes still arriving, the rebuild overran storage and the
object was reset, so the index stopped publishing until the feed ended. Leaf categories of up to
250,000 were fine.

How large a category can be is set by the edge, not the indexers: `catalog-edge` holds a listing's
segments whole, in an isolate of 128 MB, so their bytes together are capped at `LISTING_MAX_BYTES`
(64 MiB). A member with four facets, a price on three variants and a sorted price, and one more number
costs about 40 bytes (the size test in `product-listing.test.ts`), so a category holds about 1.5
million products; more facets or numbers mean fewer. A larger set of products is for search, not a
category page. After a build, an indexer whose segment is over 80% of its share of the cap
(`LISTING_MAX_BYTES / LISTING_SEGMENTS`) logs `listing_near_cap` with the channel, category,
segment, members, bytes and `share` (of the cap the whole listing is estimated at, since segments
are about the same size).

Four parts:

- **What goes in.** `listingSpec(types, channel)` (`listing-spec.ts`) takes each type's latest
  version: term attributes are `brand` plus every filterable, non-localized attribute of kind `enum`,
  `multi_enum`, `bool`, `text` or `ref` (`TERM_KINDS`); numbers are `price` plus every filterable or sortable `number`, `money`, `measure` or `date` attribute;
  sorts are `price` plus the sortable ones among those; `buckets` are the edges an attribute declares; and
  `labels` hold attribute and value labels in each of the channel's locales. `ListingSpec.buckets`
  and `labels` are stored in every segment's blob (`ListingIndex.labels`, `ListingIndex.buckets`);
  a query that names no buckets counts the most recently built segment's, and its labels are the
  listing's (`listingLabels`).
- **Routing changes.** The catalog's queue consumer (`index.ts`) hands every batch of
  `orderloop-catalog-changes*` messages (the name carries a customer's suffix) to `applyChanges`
  (`listings.ts`), which expands each change's categories to their ancestors (`withAncestors`: a
  product in Tees is listed in Tops too) using the category tree from `CatalogMeta`, cached for 30
  seconds in the isolate, and calls the `ListingIndexer` of each listing segment it enters or leaves
  (the product key's segment, in each category) once per batch. A category that moved reaches its old listings only on a `reindex`. A failed batch retries
  whole; changes are idempotent.
- **`ListingIndexer`** is a Durable Object per `<channel>:<category>:<segment>` (`LISTINGS`, SQLite) with tables
  `members` (key, uid, `at`, `created_at`, `live`, `sig`), `terms`, `nums` and `settings`. Changes arrive at
  least once and in any order, so a member keeps the change with the latest `at`; a removal is a
  tombstone (`live` 0) that stays 24 hours so a late older change can't bring the product back. A
  change whose entry has the member's stored signature (`entrySignature`: uid, `createdAt`, terms and
  numbers, which is all the index uses) only moves `at`, unless the change is `forced` (a reindex,
whose new document format, locale or labels change the index without changing the entry). A
  change that alters anything sets `dirty` and an alarm, at least `debounceMs(members)` after the
  segment's last build (a second per 20,000 members of the last build, at least `DEBOUNCE_MS`, 15 seconds, and
  at most 5 minutes), so a feed that touches a category thousands of times rebuilds it a handful of times;
  changes during a build rebuild once more after the debounce. The build uses the config at the
  highest `rev` its changes carry (`ListingChange.rev`), from an isolate copy at most 2 seconds old.
  The alarm streams the members, ordered
  newest first by the second (`CAST(created_at / 1000 AS INTEGER) DESC, uid`, index `members_second`; the builder refuses any other order), into `ListingIndexBuilder` (uids and their `createdAt`, then each term value's members, then each numeric
  column, counted per member with a `GROUP BY uid` and then filled in place, then `finish`) and puts `idx/f1/<channel>/<category>/<segment>.bin` in `PUBLISHED` with custom
  metadata `members` and `builtAt`, and records `members` in `settings` for the next debounce. `buildListingIndex` is the same builder over an in-memory array
  (tests). A channel that no longer exists keeps its last index. The blob is format 3 (the header's
  version; the decoder refuses any other, so after a deploy that changes it a listing whose
  segments aren't all rebuilt answers `503` `listing rebuilding` (`MISSING`) rather than a partial
  page: run a `reindex`). A build that throws leaves the segment `dirty` and logs
  `listing_build_failed`, so the alarm's retry builds it again. Format 3 stores creation times as
  whole seconds (`listingSecond`, Uint32), each member's distinct values only, and a numeric column
  no member has two values in as one value per member with no offsets (a missing value is
  `-2^31` in an Int32 column, `NaN` in a Float64 one), which took a typical member from about 54
  bytes to 40. Format 2 stored `createdAt` in milliseconds (Float64) and every value with offsets;
  format 1 had no `createdAt`.
- **Querying.** `queryListing(segments, q)` runs the filters on every segment (`ListingIndex.scan`)
  and adds up: `total` and each facet value's count are summed (then sorted by count, then value),
  a range's `min` and `max` span the segments, and its buckets, counted with the same edges in each,
  are summed. The page is a k-way merge of the segments' own orders by the sort key: `newest` is
  the creation second descending (products created in the same second are in uid order), `<attr>_asc` a member's lowest value ascending and `<attr>_desc` its
  highest descending (members without a value last either way, so a segment with no values for the
  attribute is all last), each tie broken by `createdAt` descending and then uid, which is also the
  order within a segment. The cursor is each segment's position in its order, in base 36 joined by `.`
  (`0.0.0.0.0.0.0.0` is the first page; `encodeListingCursor`, `decodeListingCursor`), so a page
  never skips or repeats a member. `next` is absent when no segment has another match. The sorts a
  listing offers are those every present segment has (`listingSorts`): the builder writes a
  sort's column even when a segment has no values for it, so a sort is missing only from a segment
  not rebuilt since it was added.

Measured in workerd (a measurement, not a guarantee): 50,000 members apply in about 0.8 seconds and
build in about 0.11 seconds into a 1.2 MB index. That was one indexer per category; a segment
builds an eighth of the category.

### Keyword search

Search is fed by the same `ListingChange`s as the listing indexes and answered from the catalog's
own Durable Objects (`apps/catalog/src/search.ts`; query handling in
`packages/core/src/product/search.ts`, zod-free, exported as `@orderloop/core/product/search`).

- **Queries.** `normalizeQuery` applies NFKC, lowercases, collapses whitespace and cuts to `QUERY_MAX`
  (100) characters; the result is the cache key. `queryTerms` takes runs of letters and digits, at
  most `QUERY_TERMS` (10). `ftsQuery` quotes every term (all required) and also matches the last as
  a prefix (`"cott"*`) when it has 2 or more characters, so user text never reaches FTS5 syntax:
  operators, column filters and quotes are just characters. A query with no term has no
  expression (`null`). `SEARCH_DEPTH` (1,000) is how many results a search can page through.
- **What goes in.** `renderForChannel` builds one `SearchEntry` per channel and locale: title, brand,
  SKUs and a `body` of the description and searchable attributes (variants' too), capped at
  `SEARCH_BODY_MAX` (4,000) characters so a change message stays small.
- **`SearchShard`** is a Durable Object, 16 of them (`SEARCH`, SQLite, `search-<n>`, `n` from
  `searchShard(key)`, frozen like `productShard`), reached through `searcher()` in `config.ts`
  with the deployment's jurisdiction. Each holds one FTS5 table per channel and locale
  (`table()`: `fts_<channel>__<locale>`, each with any character but a letter or digit written as
  `_` and its hex, so `b2b-eu` and `b2b_eu` never share one; created on first use) with columns `title`, `brand`, `skus`, `body`
  and `uid` (`UNINDEXED`), tokenized with `unicode61 remove_diacritics 2` ("creme" finds "crème")
  and `prefix = '2 3'`. `seen` keeps the latest `at` per key and channel (an older change is
  skipped; a removal is a tombstone pruned after 24 hours) and `rows` which FTS rows a product
  owns (and in which table), so a change deletes them and inserts the new ones in one transaction.
  Tables from before the encoding (every other character as `_`) are still read by `search()` until
  the new one exists, and a [reindex](#catalog-admin-api) moves each product's rows into the new
  table as it re-applies them; codes of letters and digits only kept their names. Results rank by BM25
  weighted title 10, SKUs 8, brand 3, body 1 (lower is better). `search()` returns that shard's
  best `k` and how many match.
- **Routing changes.** The queue consumer runs `applyChanges` and `applySearch` together on each
  batch of `orderloop-catalog-changes*` messages; `applySearch` sends each shard its items in one
  call. A failed batch retries whole, and both halves are idempotent by `at`. Products published
  before search existed enter it on `reindex`.
- **`SearchApi`** is a `WorkerEntrypoint` for `catalog-edge`: `search(channel, locale, q, limit,
  offset)` normalizes the query, asks all 16 shards for their best `min(offset + limit,
  SEARCH_DEPTH)` in parallel, merges by score (ties by uid) and answers `{ total, uids }`. A page is
  one round of 16 small queries.

**`CatalogMeta`** is one Durable Object (`meta`) holding product types (every version), channels
and categories, with a `rev` counter that moves on every type or channel change. A type's version
may only add (`typeChangeIssues`), and a new type starts at version 1. A channel's `defaultLocale`
must be one of its `locales`. Categories refuse unknown parents and cycles. It publishes each
channel's category tree to R2 (`docs/f1/<channel>/<locale>/categories.json`) when a channel or
categories change. A changed channel currency or locale list reaches documents already published
only when they are re-rendered, which `reindex` does. Deleting a type, a channel or categories is
described under [Catalog admin API](#catalog-admin-api) and `CatalogApi`; `deleteType` and
`deleteChannel` bump `rev`, and deleting categories republishes the trees.

### Feed import

A feed is a CSV or NDJSON file of products. `CatalogApi.startFeed` stores it, and the `FeedImport`
Workflow (`orderloop-catalog-feed`, `apps/catalog/src/feed-import.ts`; up to 10,000 steps) turns it
into shard batches in steps that each read a bounded slice of the file:

1. `read header` reads the first MiB of a CSV for its header row (`csvHeader`: the `key` and `sku` columns are required, else the feed fails) and the file's size. An NDJSON feed has no header and starts at byte 0, line 1.
2. `split <n>` reads up to `FEED_CHUNK` products (25,000; the `FEED_CHUNK` variable) from the byte offset the last chunk ended at, always a product boundary, with a ranged R2 read. It validates each product against the catalog's types (`validateProduct`), groups the valid ones by `productShard`, writes one part per shard to R2 (`feeds/<id>/parts/<chunk>-<shard>.ndjson`) and sends one `FEED_PARTS` queue message per part (in sends of 100). It returns the offset and row to resume from, so a feed of any size is many short steps; the step retries up to 3 times (10 seconds, exponential).
3. `record <n>` adds the chunk's rows, parts, rejected rows and error samples to `CatalogFeeds` (by chunk number, so a replay counts once).
4. After the last chunk, `split done` moves the feed to `applying`. A `check <n>` step then compares parts applied with parts produced; until they match the Workflow waits for an `applied` event (`applied <n>`, up to a minute, then looks again). `finish` marks the feed `done`. Any error marks it `failed` (`fail`, with the message as `failure`) and rethrows.
5. A cancelled feed (`cancelFeed`) normally has its instance terminated. If that fails, the Workflow returns at its next `record <n>` or `check <n>`, both of which read the feed's state. Parts already queued still apply.

`CsvRecord` and `NdjsonRecord` carry `end`, the byte offset past each record, which is what makes the
offsets a resumable cursor; the parsers therefore require UTF-8 and fail on invalid bytes, and they
cancel the stream when the reader stops early (a full chunk). A row's number is its CSV record or
NDJSON line number (the header is row 1), and a product's rows are numbered from its first.

The queue consumer (`queue` in `index.ts`, batches of 10, `max_batch_timeout` 1 second) calls
`applyPart` for each message: it reads the part from R2, sends the shard one `apply` batch with the
batch id `<feed>:<part>` and the config `rev` the chunk was validated against, counts the results
(`created`, `updated`, `unchanged`, `rejected`) and records the part with `CatalogFeeds`; the part
that completes an `applying` feed wakes the Workflow with `sendEvent`. A failed delivery retries
after `10 * attempts` seconds; the fifth failed delivery (queue `max_retries` 4) calls `failPart`,
which records the part's rows as rejected with one error (`part <id> failed: …`) and acks. The queue has a
dead-letter queue (`orderloop-catalog-feed-parts-dlq`), but `failPart` acks first, so a message
reaches it only if the handler itself throws (`failPart` failing, say) until the queue gives up.
Part ids are deterministic and the shard batch id is the part id, so a retried step or a redelivered
message never applies a row twice.

**`CatalogFeeds`** is one Durable Object (`feeds`) holding every feed's `FeedStatus`: `queued`,
`splitting`, `applying`, `done`, `failed` or `cancelled` (the last three final: `splitDone`, `finish`,
`fail` and `cancel` leave them as they are), with `rows`, `parts`, `partsDone`, the four counts and
at most 100 `errors` (`FEED_ERRORS`, by row). Rejected rows come from validation (the Workflow) or
from a shard (`already used by <key>`).

The Durable Object namespaces are reached only through `apps/catalog/src/config.ts` (`meta`,
`shard`, `shardFor`, `feeds`, `indexer`, `searcher`), which applies the deployment's `DATA_JURISDICTION` (`eu`, `fedramp`, or empty;
any other value throws). See [Data residency](data-model.md#data-residency).

## Catalog edge

`orderloop-catalog-edge` (`apps/catalog-edge`) is the public, read-only catalog API. It is a
Worker on the custom domain `catalog.<domain>` (`catalog.orderloop.app` for the `orderloop`
deployment), with no `workers_dev` or preview URLs. It reads what the catalog published (R2
`PUBLISHED`, KV `CARDS`) and holds no state of its own. It has two entrypoints, and Workers Caching
(`cache.enabled`, with `cross_version_cache`, so a deploy doesn't empty the cache: paths carry
`DOC_FORMAT`) sits between them:

- **The gateway** (default export, `src/index.ts`; its `exports` entry turns the cache off, since
  caching in front of it would skip normalizing). It answers `GET /health` with `{ ok: true }` and
  `OPTIONS` with `204` (`access-control-allow-methods: GET, HEAD`, allowed header `if-none-match`,
  max-age 86400), refuses anything but `GET` and `HEAD` with `405` (`{ "error": "read only" }`,
  `allow: GET, HEAD, OPTIONS`), then parses the route (`routes.ts`; `404` for an unknown path,
  `400` for a bad channel, locale, key, SKU, slug, or `keys`). It forwards only the route's
  canonical URL (`https://catalog.internal/v1/<channel>/<locale>/…`, unused query parameters
  dropped, keys deduplicated) and the request's `If-None-Match` to `ctx.exports.Delivery.fetch`, so
  every way of asking for the same thing is one cache entry and no cookie or other client header
  reaches it. It adds `access-control-allow-origin: *`, exposes `etag` and `cf-cache-status`, and
  writes one Analytics Engine data point per routed request without waiting on it (blobs: route kind,
  channel, status, `cf-cache-status` or `NONE`; double: latency in ms; index: channel).
- **`Delivery`** (`src/delivery.ts`, a `WorkerEntrypoint` with the cache enabled). A hit never runs
  it; concurrent misses for a URL run it once; a stale entry is served while one background request
  revalidates it. It reads and streams stored bytes and never parses a document.

| Route (`GET`, under `/v1/<channel>/<locale>/`) | Answers |
|---|---|
| `products/<key>` | The product document, `docs/f1/<channel>/<locale>/p/<key>.json` from R2 |
| `skus/<sku>`, `slugs/<slug>` | The same document, found through the R2 alias pointer (`sku:<sku>`, `slug:<locale>:<slug>`) |
| `products?keys=a,b` | `{ "products": [card or null, …] }`, in the order asked, for at most `BATCH_MAX` (100) distinct keys. Key to uid through KV `u:f1:<key>` (one bulk `get`), then cards `c:f1:<channel>:<locale>:<uid>` (a second) |
| `categories` | The channel's category tree for that locale |
| `categories/<code>/products` | One page of a category: `{ total, next, sorts, products, facets, ranges }`, filtered, sorted and faceted from the listing index, `products` being the cards in order. Query: `f.<attr>=a,b` (any of the values; attributes AND together), `r.<attr>=lo..hi` (either end may be empty), `sort` (`newest`, the default, or `<attr>_asc` / `<attr>_desc` for a sort the index has), `cursor` (`next` from the last page: an opaque string, exactly `LISTING_SEGMENTS` base-36 positions joined by `.`, no leading zeros; `next` is `null` on the last page), `limit` (default 24, at most 100). At most 20 filters and 50 values a filter |
| `search?q=<words>` | One page of keyword search: `{ total, next, products }`, `products` being the cards in match order. Query: `q` (normalized by `normalizeQuery`; `400` without a word), `cursor` (an offset, `0` to `SEARCH_DEPTH - 1`, so `400` from 1,000; `next` is `null` once the last page or the depth is reached), `limit` (default 24, at most 100) |

R2 is asked with `onlyIf` set to the request headers, so a revalidation whose `If-None-Match` still
matches is a `304` with no body read. Responses carry the object's `etag` and `last-modified`
and, for documents and category trees, `Cache-Control: public, max-age=60, stale-while-revalidate=86400,
stale-if-error=604800` (a minute fresh, a day stale while revalidating, a week if R2 fails). A
missing product, SKU, slug or category tree is `404` with `{ "error": … }` and `public, max-age=30`.
Batches, listing pages and searches carry the same fresh `Cache-Control`. Batches and listing pages,
which `Delivery` assembles, carry a strong `etag` (the first 16 bytes of the body's SHA-256, in hex),
and a request whose `If-None-Match` names it is a `304` with no body, so the cache revalidates them
without storing them again. A batch keeps key → uid entries in the isolate (up to 50,000, oldest out
first); a remembered uid whose card is missing is read from KV again, since a product deleted and
created anew has a new uid. Cards live in KV, which is eventually consistent: after a purge, a page
refilled at another location can still carry the old card for up to about a minute. Cache tags: `p:<key>` and `ch:<channel>` on a
document (a SKU or slug miss only `ch:<channel>`), `cats` and `ch:<channel>` on a category tree,
`ch:<channel>` and one `p:<key>` per key on a batch, `cat:<code>` and `ch:<channel>` on a listing page, `ch:<channel>` on a search page.

**Search.** The gateway's canonical URL for `search` keeps the normalized `q` and drops `cursor=0` and the default `limit`. `Delivery.search` calls `env.CATALOG` (a service binding to the catalog's `SearchApi` entrypoint) for the page's uids, and in parallel, on the first page only, looks for an exact SKU: when the normalized query is one code-like word (`CODE`) it reads the SKU alias pointer in R2 for the query upper-cased and then as typed, and the uid in KV, and puts that product first (and removes it from its later place; `total` counts it once more when full-text search didn't match it). It then reads the cards in one bulk KV `get` (a missing card is skipped). The response carries the fresh `Cache-Control` and the tag `ch:<channel>`, so a channel's searches go in one purge. When a search shard fails, `SearchApi` leaves its matches out instead of failing the search (and logs the shard); the response then has `"partial": true` and is cached only 30 s, so the full answer replaces it soon. Search needs the catalog Worker to exist and be reachable; the other routes don't.

**Listing pages.** The gateway's canonical URL for a listing sorts filters by attribute and values
within each, joins them with `,`, and omits `sort=newest`, the first page's cursor
(`0.0.0.0.0.0.0.0`) and the default `limit`, so equivalent requests share one cache entry; a cursor
is accepted only in its one spelling. `Delivery` loads every segment of the listing in parallel, each through its own
`/_idx/<channel>/<category>/<segment>` path, called on itself so it goes through Workers Caching
(`public, max-age=30, stale-while-revalidate=300`, tags `cat:<code>` and `ch:<channel>`); the
gateway never routes `/_idx/`, so it is not public. A segment that doesn't exist (a small category
needn't have members in every one) counts as empty; a listing with no segment at all is unknown.
Each isolate holds decoded listings (zero-copy views over the bytes) as a unit, every segment
together, up to 32 MiB in all (`INDEX_LIMITS.budget`): other listings go out least recently used
first, never a segment of the listing being kept, so a listing over the budget is held on its own
rather than re-downloaded in part. A segment with no object is held too (an empty entry), so a small
category doesn't ask for its empty segments on every request. A held segment is trusted for 30
seconds and then revalidated with its ETag, so an unchanged segment is a `304` and nothing is
downloaded or decoded again; an empty one is asked for again. Concurrent requests for one listing
share one load (a request waits on another's for at most 5 seconds, then loads it itself). The
internal path sends each segment's `content-length`, and a listing whose segments (held and
fetched) add up to more than `LISTING_MAX_BYTES` (64 MiB, `INDEX_LIMITS.max`) is never buffered:
the page is `503` (`listing too large`, `MISSING`) and the size is logged. The bytes actually read are held to the
same cap. A page reads its cards from KV in one bulk `get` (a
card missing from KV is skipped) and returns facets (`{ attr: { label, values: [{ value, label, count }] } }`,
the top 50 values by count, counted disjunctively over the whole result) and ranges
(`{ attr: { label, min, max, buckets } }`), with labels in the request's locale (the code when none).
An unknown category is `404` (`no such category`, `MISSING`); a sort the index lacks is `400`
(`unsupported sort`, with the available `sorts`); a malformed filter, range, sort, cursor or limit is `400`.

The Worker is also the consumer of the purge queue (`orderloop-catalog-purge`) the catalog's
`PURGE` binding feeds. `drain` (`src/index.ts`) takes a batch's messages oldest first, packs whole
messages into calls of at most `PURGE_TAGS` (100) deduplicated tags (a larger message is split) and
purges through `Delivery.purge`, since Workers Caching scopes a purge to the entrypoint that calls it.
Purges are rationed (the Free-plan limits: about 5 calls a minute), so the consumer runs one batch at
a time and waits `PURGE_PACE_MS` (12 seconds, `scheduler.wait`) after each call. A message is never
dropped for its age: documents stay servable stale for a day (`stale-while-revalidate`), so a missed
purge would serve the old copy once more. After `PURGE_CALLS` (40) calls, 8 minutes, the batch hands
its remaining messages back to the queue at once, inside the consumer's 15-minute limit. When a call is refused, the messages it hadn't covered are
retried with a 30 second delay (those already purged stay acknowledged); after `max_retries` they go
to the dead-letter queue. `purge` is a no-op where there is no Workers Caching (local
development and tests). Freshness otherwise comes from `max-age` and ETag revalidation; only urgent
writes queue a purge.

Bundle: about 10 KiB gzipped (segmented listings added about 1 KiB to the 9.4 it was), because it imports only `@orderloop/core/product/paths`, `@orderloop/core/product/listing` (the zod-free index decoder and merged query, with `LISTING_SEGMENTS`) and `@orderloop/core/product/search` (the zod-free query helpers), never zod or the model.

## Bindings

| Binding | Worker | Resource |
|---|---|---|
| `ORDER_AGENT` | engine | Durable Object class `OrderAgent` (SQLite, migration tag `v1`) |
| `ASSISTANT_AGENT` | engine | Durable Object class `AssistantAgent` (SQLite, migration tag `v2`) |
| `A2A_AGENT` | engine | Durable Object class `A2AAgent` (SQLite, migration tag `v3`) |
| `CART_AGENT` | engine | Durable Object class `CartAgent` (SQLite, migration tag `v5`) |
| `ORDER_LOOP` | engine | Workflow `orderloop-order`, class `OrderLoop`, `limits.steps: 10000` |
| `REPLENISH` | engine | Workflow `orderloop-replenish`, class `Replenish`, schedule `0 6 * * *` |
| `DB` | both | D1 `orderloop`, migrations in `packages/db/migrations` |
| `DOCS` | both | R2 `orderloop-docs` |
| `AI` | engine | Workers AI |
| `ENGINE` | web | Service `orderloop-engine`, entrypoint `EngineApi` |
| `CATALOG` | web | Service `orderloop-catalog`, entrypoint `CatalogApi` (`/api/v1/catalog`) |
| `OAUTH_KV` | web | KV namespace for MCP and A2A OAuth clients, grants and tokens; created on first deploy |
| `PLUGIN_<ID>` | engine, web | Service `orderloop-plugin-<id>`, one per installed `worker` plugin, rendered from the registry's `plugins`; the default entrypoint implements `PluginRpc`. The plugin's Worker holds its own `PLUGIN_KEY`, never `PRINCIPAL_KEY` ([Plugins](plugins.md)) |
| `LOADER`, `PLUGIN_STORAGE` | engine | Worker Loader and the Durable Object `PluginStorage` (migration tag `v4`) that run a `sandboxed` plugin ([Plugins](plugins.md#runtimes)) |
| `SHARD` | catalog | Durable Object `CatalogShard` (SQLite, migration tag `v1`), 64 of them |
| `META` | catalog | Durable Object `CatalogMeta` (SQLite, migration tag `v1`), one |
| `FEEDS` | catalog | Durable Object `CatalogFeeds` (SQLite, migration tag `v2`), one |
| `FEED_IMPORT` | catalog | Workflow `orderloop-catalog-feed`, class `FeedImport`, `limits.steps: 10000` |
| `LISTINGS` | catalog | Durable Object `ListingIndexer` (SQLite, migration tag `v3`), one per channel, category and listing segment |
| `SEARCH` | catalog | Durable Object `SearchShard` (SQLite, migration tag `v4`), 16 of them named `search-<n>` |
| `PUBLISHERS` | catalog | Durable Object `CatalogPublisher` (SQLite, migration tag `v5`), `PUBLISH_FANOUT` per shard named `pub-<shard>-<n>`: the shards' storage writes |
| `FEED_PARTS` | catalog | Queue producer for `orderloop-catalog-feed-parts`; the Worker consumes it |
| `CHANGES` | catalog | Queue `orderloop-catalog-changes` (dead-letter queue `orderloop-catalog-changes-dlq`); producer and consumer are the catalog Worker |
| `DB` | catalog | D1 `orderloop` (the web app's database): the catalog writes `products.name`, `price`, `catalog_at` and the weight and size columns ([Order Loop's products](#order-loops-products)) |
| `PUBLISHED` | catalog | R2 `orderloop-catalog`: product documents, alias pointers, category trees, listing indexes |
| `PURGE` | catalog | Queue producer for `orderloop-catalog-purge` (`{ tags }` messages) |
| `CARDS` | catalog | KV namespace of listing cards and `u:f1:<key>` uid entries; created by `provision.sh` |
| `PUBLISHED` | catalog-edge | R2 `orderloop-catalog`, read |
| `CARDS` | catalog-edge | The same KV namespace, read |
| `CATALOG` | catalog-edge | Service `orderloop-catalog`, entrypoint `SearchApi` (keyword search) |
| `ANALYTICS` | catalog-edge | Analytics Engine dataset `orderloop_catalog_edge` |
| (queue consumer) | catalog-edge | `orderloop-catalog-purge`, dead-letter queue `orderloop-catalog-purge-dlq` |

Variables and secrets are listed in [Configuration](configuration.md).

## Plugins

A deployment can install plugins: Workers of their own with their own D1 databases, or sandboxed
bundles the engine loads itself, that add node
types, receive outbound events and serve pages. The contract (`PluginManifest`, `PluginRpc`,
`NodeRegistry`, `withPlugins`) is `packages/core/src/plugins.ts`; `validateGraph` takes a registry,
so a plugin's `<id>.<name>` nodes validate only while it is installed, and the planner is untouched.
The engine (`apps/engine/src/plugins.ts`) finds plugins by their `PLUGIN_*` service bindings, caches
their statuses (`pluginStatuses`: manifest, `healthy`, `error`) for about 60 seconds and keeps a
plugin's last good manifest while it can't answer. It runs a plugin node inside its own `step.do`
under a timeout, with the order and event data redacted (`pluginOrder`, from an allowlist) unless the
manifest sets `personalData: 'send'` and the deployment grants it (`PLUGIN_GRANTS`), checks the
result (`checkExecResult`) and merges its variables into `vars.plugins.<id>`; events go through the
outbox. A plugin that is bound but not answering is retried, and a node's branch is checked against
the manifests the run was planned with (`flowManifests`). The web app forwards `/plugins/<id>/*`
with a principal signed with the plugin's own key (`pluginKey`, no session id;
`apps/web/app/lib/plugins.server.ts`), which filters request headers, applies the manifest's
`pageRole`, rate-limits signed-in requests per person and public paths per caller, size-caps
bodies, passes only allowlisted response headers and same-plugin redirects, and puts the app's
own security headers on the response (a CSP that allows no script); it reads node specs through `useNodes()` and shows each plugin's status at `/plugins`
(`apps/web/app/routes/plugins.tsx`, admin). `EngineRpc` has
`pluginCatalog`, `pluginUsage` and `pluginFetch`, and deep health a `plugin_<id>` check each. Plugins are written
with `packages/plugin-sdk`. See
[Plugins](plugins.md) for the contract, installing and removing.

The engine's plugin host (`apps/engine/src/plugin-host.ts`) runs the `sandboxed` ones. `pluginStub`
returns a plugin's `PLUGIN_<ID>` binding when it has one; otherwise it loads the bundle pinned in
`PLUGIN_BUNDLES` (verified against its sha in `DOCS`) through `LOADER` as a Dynamic Worker, cached
by `plugin:<id>@<sha>`, so a plugin behind either runtime is called the same way (`PluginRpc`) and
`installedPlugins` lists both. The Dynamic Worker has no bindings: its env is `STORAGE`
(`PluginDb`, over the `PluginStorage` Durable Object for its id), `SECRETS` (`PluginSecrets`) and its
own `PLUGIN_KEY` (for a runtime install, its version's: `pluginKey(…, id, sha)`, which the web app signs with from `PluginStatus.sha`); its `globalOutbound` is `PluginEgress` (https only, its manifest's `egress`, and
header injection for the secrets declared `inject`) and its tail is `PluginTail` (logs to the
engine's, exceptions to `plugin_errors`). Each call is capped by `limitsFor`. Because only the
engine can load it, a sandboxed plugin's pages go web app → `EngineRpc.pluginFetch` → plugin, with
the same request building and response rules as for a Worker plugin. The capability classes are
exported from `apps/engine/src/index.ts`, where the loader's `ctx.exports` finds them.

## Connectors

`apps/engine/src/connectors.ts` holds mock commerce connectors over the D1 back office
(`customers`, `products`, `contract_prices`, `price_sources`, `price_rules`, `reservations`,
`stock_movements`, `locations`, `location_stock`, `entitlements`, `payments`,
`shipments`, `messages`)
and R2. Each function is the seam where a real adapter (a WMS, a carrier API, an ERP)
replaces the mock. Payments already have one: `apps/engine/src/payments.ts` (re-exported from
`connectors.ts`) records each payment in D1 and, with `PAYMENTS_MODE=stripe`, calls Stripe through
the fetch client in `apps/engine/src/stripe.ts` (form encoding, pinned `Stripe-Version`,
`StripeError`, a 15-second timeout per request, no SDK and no retries of its own). Card errors take
the node's declined or failed branch; Stripe 5xx, 429, 409, network errors and timeouts throw so
the step retries (every write carries an `Idempotency-Key`); any other refusal is a
`NonRetryableError`. `paymentSource` in `packages/core/src/payments.ts` picks external, offline,
adopt, confirm, off-session or none from `order.payment`, the node's method and the customer's
saved card, and `toMinor`/`fromMinor` (`packages/core/src/money.ts`) convert amounts, with
zero-decimal currencies. `validateAddress` is the seam for an address provider (USPS, Loqate); the mock
calls `checkAddress` from core. `quoteShipping` POSTs to a shipping-rate node's live carriers
(https, 5 seconds, credentials from `SHIPPING_CARRIER_AUTH`) and falls back to the node's
configured services; it and the Stripe calls are the connectors' only outbound requests.
`apps/engine/src/gateway.ts` holds what payments and billing share: the mode, the client,
`rethrow` and `ensureCustomer` (the account's Stripe customer, created once under `cust_<id>`).
`apps/engine/src/billing.ts` issues `commerce.invoice`'s Stripe invoices in the order Stripe needs
since API 2022-08-01: customer, a draft with `pending_invoice_items_behavior=exclude`,
`auto_advance=false` and `collection_method=send_invoice`, each item created with `invoice=in_…`,
finalize, then send; each call keyed from the invoice row id (`inv_…`, `inv_…_item_<n>`,
`inv_…_finalize`, `inv_…_send`). `settleInvoice` marks the invoice paid, records the
`invoice_payment` and settles the account charge in one D1 batch; `handleStripeEvent`
(`apps/engine/src/payment-events.ts`) calls it for `invoice.paid`.

Two rules hold for every connector:

- **Writes are keyed by the step that made them.** Ids embed the order id and the step key, for
  example `res_${orderId}_${stepKey}_${line}_${sku}`, `pay_${orderId}_${stepKey}`,
  `shp_${orderId}_${stepKey}`, and inserts use `onConflictDoNothing`. Every order on a flow shares
  its step keys, so the order id is what keeps two orders apart. A retried step finds its own row
  instead of writing a second one. `refund` returns the refund its step already made, and never
  refunds more than was captured or charged; with Stripe payments it spreads over them newest
  first, one row (`rfd_…`, `rfd_…_1`) and Stripe refund per payment. A Stripe call's
  `Idempotency-Key` is the row id, so a retried step replays Stripe's first answer. Stock changes (`reserveInventory`'s holds and
  `restock`) go through the `stock_movements` ledger, which records each change and applies it to
  `products` (or, with a `location_id`, a store's `location_stock` row) in one batch, once. A hold is written only while the stock is still free. Capture flips its authorization to `captured` and records the capture in one batch, and a retried capture returns the one already recorded.
- **After a continue-as-new, keys gain the generation.** The ids above embed the effect key, `${nodeId}#${run}@g${generation}` from generation 2 on (see [OrderLoop Workflow](workflow.md#step-names)).
- **Compensations are idempotent.** `releaseInventory` releases only `held` reservations (each
  release is a ledger movement, so a cancel racing a rollback releases once),
  `voidAuthorizations` voids only `authorized` payments (a void racing a capture leaves exactly
  one of them; a Stripe one is canceled in Stripe first, and D1 changes only after), `cancelShipment` sets one shipment
  `cancelled`, `revokeEntitlements` revokes only `issued` codes, `restoreShippedStock` restores a `consumed` reservation once, `reverseBalance` reverses a balance entry once (and not one a paid invoice settled), `voidInvoices` voids an invoice in Stripe before D1 and leaves a paid one alone. Running one twice changes nothing.

The saga compensations a failed order runs are `ROLLBACKS` in `apps/engine/src/nodes.ts`; a
cancel runs `compensateOrder`, which releases, voids, cancels open shipments and staged pickups, revokes issued digital codes, voids unpaid Stripe invoices, restocks shipped stock once no shipment is live, reverses on-account charges, cancels seller orders and reverses scheduled payouts in one pass. A node
type with `rollback: true` in the catalog must have a `ROLLBACKS` entry.

To exercise failure paths, set `meta.simulate` on the order input. The engine honours it only when
`SIMULATE_FAILURES` is `"true"` (local dev, the engine tests and demo deployments); otherwise
`start` in `apps/engine/src/orders.ts` drops it (`withoutSimulation`) before the order exists, for
every caller: the web app, `/api/v1`, inbound orders, email intake, A2A and UCP.

| `meta.simulate` | Effect |
|---|---|
| `out_of_stock` | `reserveInventory` reports every line short |
| `payment_decline` | `authorizePayment` records a `declined` authorization (with `PAYMENTS_MODE=stripe` and a test key: confirms with `pm_card_visa_chargeDeclined`) |
| `charge_fail` | `charge` records a `failed` charge (likewise on Stripe) |
| `three_way_mismatch` | `commerce.three_way_match` sees an invoice 10% over the order total |

Documents go to R2 through `storeDocument` at `orders/<orderId>/<kind>/<name>` and are indexed in
the `documents` table (see [Data model](data-model.md#r2-documents)).

## Scheduled replenishment

`Replenish` (`apps/engine/src/replenish.ts`) runs on the `REPLENISH` binding's cron. Its
`scan stock` step lists SKUs where `stock - reserved <= reorder_point`; if there are any, its
`start reorder` step seeds the templates and starts one order on `tpl-reorder` (or
`payload.flowId`) for customer `cus_internal`, with the SKUs in `meta.skus`. The reorder flow's
`ai.forecast` node decides the quantities. The order starts through `startOrderOnce` with the idempotency key `replenish:${instanceId}`, so a retry of the step finishes the order it already wrote. `EngineRpc.runReplenish` creates an instance on demand.

## Where state lives

Durable Objects are reached only through `apps/engine/src/namespaces.ts`: `orderAgent`, `a2aAgent` and `cartAgent` for stubs, and `scopedEnv` for `routeAgentRequest`, which looks namespaces up on the `env` it is given. They put each namespace in the deployment's jurisdiction (`DATA_JURISDICTION`); an object reached without it is a different, empty one. Never call `env.ORDER_AGENT.getByName` and the like directly: `tests/namespaces.test.ts` fails if engine source does. See [Data residency](data-model.md#data-residency).

| State | Owner |
|---|---|
| Live run state of one order (nodes, edges, waits, vars, timeline) | Its `OrderAgent` |
| A person's assistant conversation | Their `AssistantAgent` |
| A cart's lines, quote, who has it open and its chat | Its `CartAgent`; the Carts list reads the `carts` row it writes |
| Durable progress (memoized step results, sleeps, waits) | Its `OrderLoop` instance |
| Order index for lists and filters (`orders` row) | D1, written by the agent's `syncIndex` |
| Flows, versions, approvals, back office, webhook outbox, email intake log | D1 |
| Invoices, POs, inbound documents and raw inbound email | R2 |
| Products, alias claims and the publishing outbox | `CatalogShard`, one of 64 |
| Product types, channels, categories | `CatalogMeta` |
| Published product documents, category trees and listing indexes | R2 (`orderloop-catalog`) |
| Published listing cards and key to uid entries | KV (`CARDS`) |
| Who is listed in each category (members, terms, numbers) | `ListingIndexer`, one per channel, category and listing segment |
| Cache tags awaiting a purge; listing changes awaiting an indexer | The `orderloop-catalog-purge` and `orderloop-catalog-changes` queues |

## Carts

A cart (`packages/core/src/cart.ts`) is lines several people build together before they become an
order. Each lives in a `CartAgent` (`apps/engine/src/cart/agent.ts`), opened by
`EngineRpc.createCart` (`apps/engine/src/cart/carts.ts`) for a flow that prices orders (one with a
`commerce.price` step) and an optional customer. The agent syncs `CartState`: the cart, who has it
open (`members`, from the live connections) and the newest 50 chat messages (`CART_CHAT_BROADCAST`;
the rest is in its SQL, paged by `history`).

- **Pricing.** Nobody sets a price. After each op that changes lines or promo codes the agent
  prices the cart with the flow's pricing nodes through `quoteCheckout`, exactly as a UCP checkout
  is priced, for the cart's customer (`DraftExtra` in `apps/engine/src/ucp/quote.ts`) with its codes in
  `meta.promoCodes`. A quote that finishes after the cart changed again is dropped, and a cart is
  ready only when its quote is for its current `version` and found no errors (`cartReadyProblem`).
- **Promotion codes.** A cart's codes ride in `meta.promoCodes` on its quote and its order. A
  code the flow's `commerce.discount` step leaves out comes back as a `promotion` warning on the
  cart (`quoteCheckout` reads the step's `promotionsRefused`), and so does a cart whose flow has no
  such step; warnings never block submitting.
- **Files.** The web app stores an upload (at most 10 MB, `ATTACHMENT_TYPES` only, 20 a cart) at
  `carts/<cartId>/<id>` in `DOCS` and hands it to `EngineRpc.attachToCart`, which the agent
  (`attachAs`) refuses for anyone who may not change the cart, a cart that has ended or a key not
  under the cart; a refused file is deleted. `detach` (whoever added it, or an operator) removes and
  deletes it. Downloads (`/carts/<cartId>/attachments/<id>`) go to staff and to the cart's own buyer
  (`cartActor`), as attachments under a sandboxing CSP.
- **Ops.** `applyCartOp` applies one at a time: add (into the line with that SKU), set quantity
  (0 removes), remove, clear, promo codes, and, for staff, lock, unlock and rename. Staff need
  `viewer` to read and `operator` to edit.
- **Lock, unlock and rename** keep a current quote current (they bump the version and the quoted
  version together), so a locked cart can be submitted.
- **Submitting** (`submitAs`, operator) holds the cart locked before its first await, without bumping its version, while
  `startOrderOnce` starts an order of the cart's flow keyed `cart:<id>` (channel `manual`,
  `externalId` the cart id, lines from the quote, `meta.cart` and `meta.promoCodes`), then marks it
  `submitted` with the order id. Approvals happen in that order's flow.
- **The socket.** A cart's socket sends the whole cart as it opens, so `cartGate`
  (`apps/engine/src/cart/gate.ts`), run by `routeAgents` (`apps/engine/src/agent-routes.ts`)
  before the request reaches the object, refuses one without a signed principal for that cart's
  path and a live sign-in (`401`), below viewer (`403`), or for a cart the `carts` table doesn't
  have (`404`). The gate keys on the route the SDK matched (`CART_AGENT` and its name), not the path's
  spelling, so `//agents/cart-agent/…` is checked too. Each call re-reads the person with
  `livePrincipal`, and since broadcasts reach a socket that never calls, `recheckConnections` runs
  every 30 seconds while anyone has the cart open and closes (`4401`) each socket whose person can
  no longer read it. Chat messages are posted as
  the caller (`say`), changed or deleted only by their author, at most 10 in 10 seconds each.
- **Outside the page.** Staff principals (API tokens, OAuth MCP/A2A callers, the assistant) reach
  staff carts through `EngineRpc.changeCart`, `submitCart` and `cancelCart`
  (`apps/engine/src/cart/carts.ts`), which call the agent's `applyAs`, `submitAs` and `cancelAs`
  with a `StaffCartActor` the caller's server built from the signed principal (`staffCartActor`);
  they refuse a guest actor, an op that fails `cartOpSchema`, and an external cart (`notFound`, as
  for an unknown id: it belongs to its buyer's page). Reads are `cartView`: the cart without
  `external`, chat, files or members. The REST routes (`/api/v1/carts`, `handleCarts` in
  `apps/web/app/lib/api.server.ts`) check viewer or operator first and audit `cart.created`,
  `cart.canceled` and, for a submit, `order.started` with the `cartId`. The workspace tools
  (`apps/engine/src/assistant/carts.ts`) add `list_carts`, `get_cart`, `create_cart` and
  `change_cart` (no confirm: nothing is ordered) and the `submit_cart` action, which previews and
  confirms like the order actions. What reaches the model is bounded (`boundText`) and never the
  chat; the heuristic's links name a cart by its id, not its title.

### External carts

A plugin with the `carts:external` capability opens a cart for a buyer outside OrderLoop (a
punchout session) through the host API ([Plugins](plugins.md#the-host-api)). The cart carries
`external`: the plugin, its `sessionRef`, `expiresAt` (an alarm cancels it then), the `returnUrl`
it goes back to, the origins that may frame it and the buyer. The plugin gets a one-time start path;
redeeming it (`CartAgent.redeemStart`, the token kept only as a hash) admits the buyer as a
`CartGuest`, whose socket header is its own envelope (`signCartGuest` / `verifyCartGuest`, `g1`)
signed for that cart's path alone, which `cartGate` accepts only for an external cart that is
still open (`410` once it was canceled). A guest edits lines (at most 20 changes in 10 seconds, each prices the cart) and chats, but can't
lock, rename, submit or cancel; the cart's chat is shared with them. Guest sockets are checked
every 30 seconds too, and closed once the cart is canceled, submitted or past its time, or the
plugin loses its grant. A cart past `expiresAt` takes no start link and admits no guest even before
its alarm runs, and an alarm that fires mid-return looks again 10 seconds later. `transfer` (the buyer only) sends the cart back: the core holds it, calls the plugin's
`renderReturn`, keeps the fields (`returnForm` returns them again) and marks the cart `returned`.

In the web app the start path is the route `/cart/start/:cartId/:token`: it redeems the link
(`EngineRpc.redeemCartStart`) and sets a cookie for that cart alone (`ol_<cartId>`, the `gs1`
envelope `signCartGuestSession`, `HttpOnly; Secure; SameSite=None; Partitioned`, until the cart
expires), then goes to `/cart/:cartId`, the cart without staff controls (`CartView` in
`apps/web/app/components/cart-view.tsx`, shared with the staff page). That page's CSP lets the
cart's `frameOrigins` frame it and its form post to the cart's `returnUrl` (`EMBED_HEADER`, folded
in by `entry.server.tsx`; `withSecurityHeaders` then leaves out `X-Frame-Options`). Its socket is
proxied with the cookie's guest signed for the path (`setGuestHeader`). Sending the cart back
posts the fields from the page itself, in the same window, with a button if the post doesn't
start.

The return URL goes into `form-action` as its origin and path (`parseEmbed` in
`apps/web/app/lib/csp.ts`; CSP ignores the query), with `;` `,` and `'` in the path
percent-encoded, which CSP decodes before matching, so a URL like `/punchout;jsessionid=…` still
admits the post. Both routes' refusals (`cartRefusal` in `apps/web/app/lib/cart-guest.server.ts`:
a used or expired start link `410`, no cookie `401`, a cart that has closed `410`, which the page
checks as `cartGate` does) are shown by their own `CartRefusal` boundary and may be framed by any
https page (`frame-ancestors https:`): they carry only the message, and the buyer would otherwise
see a blocked frame. Framed, the cookie is a partitioned third-party cookie (CHIPS), so a browser
that blocks third-party cookies outright (Safari's default) can't keep the buyer on a framed cart;
the buyer's system has to open it top-level there.

## The assistant

`AssistantAgent` (`apps/engine/src/assistant/agent.ts`) is an `AIChatAgent` from
`@cloudflare/ai-chat`, one Durable Object per person (binding `ASSISTANT_AGENT`, migration `v2`).
The panel in the web app talks to it over the proxied `/agents/assistant-agent/*` socket, never
through `EngineRpc`. `assistantGate` (`apps/engine/src/agent-routes.ts`) refuses any socket or request,
`get-messages` included, without a principal signed for that path and a live sign-in (`401`) or
whose id isn't the instance name (`403`) before it reaches the object; `onConnect` still closes
with `4403` on a mismatch, and keeps the principal. The `@callable()` methods are `attention()`, the data for
the top of the panel, and `preview(tool, input)`, which resolves an action against live data for
its confirm card. Tools are `ASSISTANT_TOOLS` in `packages/core/src/assistant.ts`. Reads run
directly, as do `create_cart` and `change_cart` (a cart orders nothing until it is submitted);
`decide_approval`, `deliver_event`, `cancel_order`, `submit_cart`, `publish_flow` and
`run_stock_review` use `needsApproval`, and after the confirm `runAction`
(`apps/engine/src/assistant/data.ts`) re-checks the role and the state and calls the order's
`OrderAgent` (`decide`, `deliver`, `cancel`), the cart's `CartAgent` (`submitAs`, through
`assistant/carts.ts`) or the `REPLENISH` Workflow as `<email> via assistant`. Every tool re-reads the person's session first (`livePrincipal` in
`apps/engine/src/principal.ts`, shared with `OrderAgent`). `propose_flow_change` drafts a graph
with the copilot and never saves. `draft_plugin` (admins, with `ASSISTANT_PLUGINS` on) drafts a
business-rule plugin and stages it pending, for an admin to review and approve on the Plugins page
([Plugins](plugins.md#assistant-drafted-plugins)). The model (`assistantModel` in `assistant/model.ts`) is `createAI` from
`agents/models/ai-sdk` over `ASSISTANT_MODEL`, with `ASSISTANT_FALLBACK_MODEL`
(`@cf/zai-org/glm-4.7-flash`) as its `fallback` (tried when the first fails before any output), and
`withFallback` putting the deterministic heuristic model behind both: the heuristic answers when
both fail or nothing useful arrives within 20 seconds, and `used.source` and `used.model` say who
answered (the `ai_call` log names the model). Through AI Gateway (`assistantGateway`) a turn's
calls share one `eventId`, send the registry's `aiGatewayLogs` as `collectLog`, carry `metadata` `{ prompt, surface, principal }` (`principal` is a
truncated SHA-256 of the person's id), retry up to 3 attempts (exponential backoff), bound each
attempt but the gateway's last to 20 seconds (`requestTimeoutMs`), and send
`cf-aig-collect-log-payload: false`, so the log keeps tokens, cost and metadata but not the
prompt and tool results. `sessionAffinity` (a SHA-256 of the person and the conversation: the
panel's agent, or an A2A `contextId`) keeps a conversation on one Workers AI replica for its
prefix cache. With `AI_GATEWAY_ID` empty the gateway id passed is `""`, not undefined: `createAI`
would otherwise use the account's `default` gateway, and the AI binding calls Workers AI directly
only for an empty id. See [The assistant](https://docs.orderloop.app/guides/assistant/).

The `AssistantAgent` instance is named after the person's user id, which the web app sets from the
session whatever the browser asks for. Open local development
shares one instance.

## AI calls

What an order call shows the model goes through `modelView` (`apps/engine/src/ai.ts`), which applies
`modelContext` from `packages/core/src/redact.ts` in the mode `AI_PERSONAL_DATA` names (`redact` by
default; see [Personal data](data-model.md#personal-data)). Classify, Risk score, Agent router and
Summarize build their prompts from it, as do Assess's `state` and the assistant's `assess_order`.
Extract order is the exception: it sends the inbound document text whole (first 20,000 characters).

Every AI node except Assess, and the copilot, go through `runJson` (`apps/engine/src/ai.ts`):
`response_format: json_schema`, temperature `0.2`, `max_tokens` 2048, a 20-second cap
(`AI_TIMEOUT_MS`; a caller no order waits on may pass a longer `timeoutMs`, as the plugin drafter does), and the answer checked with `conforms` (`packages/core/src/json-schema.ts`); a
non-conforming answer is treated like an error. On `AI_MODE=mock`, an error, a timeout or an empty
answer, each node's heuristic runs and the output records `source: "heuristic"`. Every answer
carries `AiProvenance` (`packages/core/src/provenance.ts`): `source`, `model` (null for the
heuristic), `prompt` (`router@1`, from `AI_PROMPTS`; bump a prompt's version whenever its
instructions or answer schema change) and `fallback` (`mock`, the error or timeout message, a
malformed answer, or the forecast's `nothing to reorder` / `no usable lines in the answer`). Assess
and the assistant's `assess_order` record it too.

Each model call (`runJson`, `clef.assess`, each assistant and A2A chat turn) logs one JSON line,
`{"type":"ai_call", source, model, prompt, fallback?, ms, tokens?}` (`logAiCall`); a fallback other
than `mock` is a warning. This is the way to read the fallback rate until metrics exist (plan item
#26). The assistant's turns are also held to `ASSISTANT_DAILY_TOKENS` a person a UTC day
(`apps/engine/src/usage.ts`, table `ai_usage`): `assistantBudgetSpent` refuses a turn with
`ASSISTANT_BUDGET_SPENT` once spent, and `finishTurn` adds `totalUsage.totalTokens` when it ends.
Heuristic turns cost nothing; MCP clients bring their own model and aren't counted. Extract order and
Summarize send at most the first 20,000 characters (Summarize's, after redaction).

Assess calls Clef directly (`assess` in `apps/engine/src/clef.ts`, `ASSESS_MODEL`) with the fixed
body `model: "clef"`, `state`, `questions`, `images`; same cap and `AI_MODE` fallback. Answers go through `clampAnswers`
(`packages/core/src/assess.ts`). Images are embedded inside the step: R2 keys under
`orders/<orderId>/` only, `https` URLs, or `data:` URLs.

The copilot (`EngineRpc.copilot`, also used by the assistant's `propose_flow_change`) fills missing
config from catalog defaults, gives edges ids, keeps existing positions and re-runs layout only when
nodes were added, then returns `validateGraph`'s errors and warnings with the graph. Every model
call, the assistant's and Assess's included, goes through AI Gateway when `AI_GATEWAY_ID` is set.
User-facing behaviour: [AI nodes and the assistant](https://docs.orderloop.app/guides/ai/).

## Template seeding

`seedFlows` (`packages/db/src/flows.ts`) publishes each template in `TEMPLATES`
(`packages/core/src/templates.ts`) whose exact JSON has never been published as a version of that
flow: a new template as version 1, a changed one as the next version. It runs:

- in the web app, through `ensureSeeded()` (`apps/web/app/lib/flows.server.ts`), the first time an
  isolate (on a demo deployment, at most once a minute) lists or loads flows (dashboard, `/flows`, a flow page, `GET /api/v1/flows`) or starts an
  order (New order form, `POST /api/v1/orders`, signed `POST /api/v1/webhooks/orders`);
- in the engine, through `ensureTemplates()` (`apps/engine/src/flows.ts`), before `Replenish`
  starts a replenishment order.

A template that matches any earlier published version is left alone, so code still running from
before a change can't roll a newer version back, and seeding twice publishes once. The dashboard's
demo scenarios are `SCENARIOS` in `apps/web/app/lib/scenarios.ts`, shown only where `demoAvailable()` finds their customers and SKUs (the demo data in `packages/db/seed`, never in production); the docs page
[Built-in flows](https://docs.orderloop.app/guides/templates/) describes them.

See [OrderLoop Workflow](workflow.md) and [OrderAgent](order-agent.md).
