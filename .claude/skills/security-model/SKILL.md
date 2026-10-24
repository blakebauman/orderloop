---
name: security-model
description: Order Loop's trust boundaries and what to check at each, for security review of a diff or a design. Covers the signed principal header between the web app and the engine, UCP platform envelopes, MCP and A2A as separate OAuth resources, API tokens and sessions, webhook signing, outbound URLs, secrets and encryption at rest, prompt injection into model nodes, personal data, the public catalog edge and the supply chain. Preloaded by the security-reviewer agent; use it directly when a change touches auth, roles, signing, secrets, webhooks, external fetches or model prompts.
license: MIT
metadata:
  repo: orderloop
---

# Order Loop security model

OrderLoop is one dedicated deployment per customer (no multi-tenancy across customers), so the
boundaries that matter are *inside* a deployment: the public internet → the web Worker → the
engine Worker, between people of different roles, between API tokens and integrations of
different scopes, and between UCP platforms. Read
[references/checklist.md](references/checklist.md) for the per-boundary checks; this page is the
map.

## The boundaries

```
browser / API client / MCP / A2A client / UCP platform / channel webhook / Stripe
        │  sessions, ol_live_ API tokens, OAuth tokens (per resource), HMAC webhooks
        ▼
apps/web  (public; resolves the caller, strips any caller-sent principal header)
        │  x-orderloop-principal: v1 (person/token) or u1 (UCP platform),
        │  HMAC over {principal, path, exp} under PRINCIPAL_KEY, TTL 60 s
        ▼
apps/engine  (reachable only through the web app's service binding; still verifies)
        │  connectors, Stripe, carriers, webhooks out, A2A push, AI Gateway
        ▼
outside world
```

`apps/catalog-edge` is a separate public, read-only Worker that serves only what the catalog
publisher wrote. `apps/catalog` is reached through its RPC binding (`ProductCatalogRpc`).

## The rules a change must keep

1. **The engine trusts a principal only when it is signed for that path and unexpired.**
   `signPrincipal` / `verifyPrincipal` in `packages/core/src/roles.ts`; the web side signs in
   `apps/web/app/lib/principal.server.ts`, the engine checks in `apps/engine/src/principal.ts`.
   Credentials (passwords, session cookies, API tokens, OAuth tokens) never reach the engine.
2. **A UCP platform is its own envelope.** `signPlatform` / `verifyPlatform` (`u1`) are accepted
   only on `/ucp/*`, never by `verifyPrincipal`, and the reverse. A platform acts only on the
   checkouts and orders it started.
3. **`/mcp` and `/a2a` are separate OAuth resources** (RFC 8707, `apps/web/app/lib/oauth.server.ts`):
   a token works only at the endpoint it was granted for. A consent grants a role no higher than
   the approver's own.
4. **Roles are checked on live data.** `atLeast(role, min)`; viewer < approver < operator < admin.
   Separation of duties (`ownOrderRefusal`) applies when the workspace setting is on. MCP and
   assistant actions preview first and run only with a single-use `cfm_` confirmation code bound
   to the person, tool and input.
5. **Inbound webhooks are verified before they are parsed into anything that acts:**
   `verifyWebhook` (timestamped HMAC with a replay tolerance, either of two secrets during a
   rotation), `verifyStripeSignature`, the Shopify HMAC. Comparisons are constant-time.
6. **Outbound URLs are https** (`isWebhookUrl`; plain http only for localhost) for webhooks and A2A
   push. Outbound deliveries are signed.
7. **Secrets at rest are encrypted** with `DATA_KEY` (`encryptSecret` / `decryptSecret`,
   `packages/core/src/encryption.ts`), bound to their row by context, with key rotation. Neither
   `PRINCIPAL_KEY` nor `DATA_KEY` is ever written to disk or logged.
8. **Untrusted text reaches a model only inside a data block** (`dataBlock`, `DATA_RULES`,
   `packages/core/src/untrusted.ts`), and a model's answer is bounded before it acts
   (`boundExtractedLines`, `boundText`, `clampNumber`).
9. **Personal data sent to a model follows the workspace mode** (`redact` or `send`,
   `packages/core/src/redact.ts`), and erasure (`eraseOrderState`) keeps amounts and statuses but
   removes the subject.

## How to review

1. Classify each changed file by boundary (the rules map's trust-boundary row lists the files).
2. For each, run the matching checks in [references/checklist.md](references/checklist.md).
3. Report only what you can tie to a line and a concrete attacker: who they are (anonymous, a
   viewer, another platform, a compromised integration), what they send, and what they get.
   Severity follows impact × preconditions; a finding that needs `PRINCIPAL_KEY` is not a finding.
4. Name the test that would have caught it (`roles.test.ts`, `principal.test.ts`, `mcp.test.ts`,
   `ucp.test.ts`, `injection.test.ts`, `webhooks.test.ts`, `integrations.test.ts`) and whether it
   exists.

Vulnerabilities in the deployed service are reported privately (SECURITY.md); a review finding
in a PR never includes a working exploit against a live deployment.
