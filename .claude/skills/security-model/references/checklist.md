# Security checklist, by boundary

Run the sections the diff touches. Each item is a question with the place to look; a "no" is a
candidate finding that still needs a concrete attacker before it is reported.

## Web → engine (principal header)

- Does every new forwarded route set the header with `signPrincipal(key, p, path)` for **its own
  path**, after deleting any copy the caller sent? (`apps/web/app/lib/principal.server.ts`,
  `ucp.server.ts` `ucpFetch`.)
- Does every new engine entry point call `verifyPrincipal` (or `verifyPlatform` on `/ucp/*`) with
  the current and previous keys, and refuse on null, rather than reading the header raw?
  `grep -rn "PRINCIPAL_HEADER" apps/engine/src`.
- Is the path the engine verifies the path it was actually called on (not a value from the body)?
- Does anything widen `PRINCIPAL_TTL_MS`, accept a missing `exp`, or fall back to
  `DEV_PRINCIPAL_KEY` outside local dev?
- Does a new socket method re-check the principal or session it needs, rather than trusting the
  one from connect time for an action the role can't take?
- Does any credential (cookie, `ol_live_` token, OAuth token, password) get forwarded to the
  engine? It must not.

## People, roles, sessions, tokens

- New action: which role does it need, and is `atLeast` checked server-side on live data (not on
  a role from the client or from a cached principal that could be revoked)?
- Approvals: is `ownOrderRefusal` applied where a person decides on an order?
- Sessions: idle and absolute limits (`SESSION_IDLE_MS`, `SESSION_MAX_MS`); is the session id
  kept out of the browser and out of logs?
- API tokens: is a revoked or expired token refused (`livePrincipal`), and does an
  integration-scoped key reach only its channel and flows (`integrations.test.ts`)?
- Sign-in flows (passkeys, TOTP, SSO, SCIM): rate limits and throttles applied
  (`rate-limit.ts`, `throttle.ts`); errors don't reveal whether an account exists.

## MCP, A2A, assistant

- Is a token granted for `/mcp` refused at `/a2a` and the reverse (RFC 8707 resource)?
- Does a new tool run as the caller within their role, and does an action preview first and need
  a `cfm_` code bound to person, tool and input (single use, `CONFIRMATION_TTL_MS`)?
- Does each caller see only their own A2A tasks and push configs?
- A2A push URL: `isWebhookUrl` checked; token sent only to the URL it was registered with.

## UCP (agentic checkout)

- Can platform A read, update, complete or cancel platform B's checkout or order? Every lookup is
  scoped by the calling platform's id.
- Is a platform header refused on `/mcp` and `/a2a`, and a principal header refused on `/ucp/*`?
- Is `complete` idempotent on `Idempotency-Key`, and refused for the same key with another body?
- Is the amount at completion the one `quoteNodes` priced (no client-supplied totals)?
- Are outbound order webhooks signed (RFC 9421, `Content-Digest`)?

## Inbound webhooks and channels

- Is the signature verified on the **raw** body before parsing, with a timestamp tolerance
  (`verifyWebhook`, `verifyStripeSignature`, Shopify HMAC)?
- Is a delivery deduplicated (receipts by delivery or event id) so a replay inside the tolerance
  doesn't act twice?
- Email intake: sender matched to a customer or allowlist, and a passing DMARC, DKIM or SPF
  required; never a webmail domain alone.

## Outbound requests

- Is every user-configurable URL validated (`isWebhookUrl`, `shippingConfigSchema` refusing http
  carriers)? Can a workspace admin point a connector at the deployment's own origin or another
  OrderLoop Worker and have it act with the engine's authority?
- Are secrets for outbound calls read from encrypted storage at call time, not copied into order
  state, step output or logs (step outputs are persisted)?

## Secrets and data at rest

- New stored secret: encrypted with `encryptSecret` under the right `secretContext`, and readable
  through a rotation (`sealedWithCurrent`)?
- Does anything log, return in an API response, or put in an error message a secret, a token, a
  session id, or a full card or bank detail?
- New column with personal data: covered by erasure (`eraseOrderState`, subjects) and retention?
- New wrangler `vars`: no secrets there (secrets are set by CI from the GitHub environment).

## Models and untrusted input

- Does new text from a customer, email, document, channel payload or web page reach a prompt
  only through `dataBlock`, under `DATA_RULES`?
- Is the model's answer bounded before it changes anything (`boundExtractedLines`, `clampNumber`,
  allow-listed routes)? `apps/engine/tests/injection.test.ts` gets a case for a new model node.
- Is personal data sent to the model only as the workspace's mode allows (`modelOrder`,
  `modelContext`)?

## Web app surface

- CSP (`csp.ts`) unchanged or tightened; no new inline script or `unsafe-*`.
- State-changing routes check origin (`origin.ts`) and the session; no GET with side effects.
- User content rendered as text, never as HTML.
- Redirects go only to same-origin paths (`next-path.ts`).

## Catalog and edge

- catalog-edge stays read-only: no binding that can write, no route that reaches the catalog's
  RPC write methods.
- Cache keys are the canonical URL, so a query string or header can't poison another product's
  entry.

## Supply chain and CI

- New dependency: needed, maintained, and does `pnpm audit --prod --audit-level high` stay clean?
- Workflows: actions pinned by full SHA, `permissions` minimal, no secrets in `pull_request` jobs
  from forks, no untrusted input interpolated into `run:` (`${{ github.event.* }}`).
