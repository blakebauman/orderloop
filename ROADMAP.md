# Roadmap

Planned work, roughly in priority order. Most of it ports ideas from commerceworker, as a node, a connector or an API surface; the flow model stays unchanged.

## Next

Nothing is scheduled. Candidates:

- **More channel adapters.** Shopify orders and EDI X12 850 purchase orders are in. Still to come: Amazon (an SP-API notification consumer and order fetch), 997 functional acknowledgements for EDI, and AS2/SFTP transport so partners can send without a provider in between.
- **Concurrent seller responses.** A marketplace order waits for one `seller.responded` per pass of its acceptance loop, so a second seller who answers in the gap gets `409` (`delivered: false`) and has to retry. Buffering early responses on the order would let every reply land the first time.
- **Default timeouts from the catalog.** When an Approval or Wait-for-event node has no `timeout`, `workflow.ts` falls back to `7 days`; the catalog defaults are `2 days` and `30 days`. Only a flow stored without the field is affected, but the two should agree.
- **Stalled means waiting too long.** The assistant calls an order stalled when `orders.updated_at` is more than a day old. That timestamp now moves only when an indexed field changes, which helps, but measuring from when the current wait opened (`orders.waiting_since`) would be truer.
- **Carry-out on the omnichannel flow, and undoing a hand-over.** `tpl-omnichannel-order` sends carry-out to its "Cannot fulfil" end (carry-out belongs to `tpl-pos-sale`), and `commerce.handover` has no rollback, so a failure after goods leave the store doesn't put the stock back.
- **Sign in with an outside identity provider.** Users already carry `external_sub`; an OpenID Connect login could match people by subject and start the same session.
- **Exchange rates people can manage.** Production has a rate for USD only, and the back office lists rates without editing them, so another currency needs a row inserted into `fx_rates` by hand. A rate editor for operators, or a daily job that fetches rates from a provider, would let orders in EUR, GBP or CAD through.
- **Revocable shared-password sessions.** The `ol_session` cookie is an HMAC of `APP_PASSWORD` with no server-side record, so the only way to end one is to change the password. A session row for the shared operator (the `sessions` table requires a user today) would let it be signed out, expire on idle like a person's session, and take the `__Host-` prefix. Until then, operators with their own sign-in (and two-factor) are the better way in.
- **Deterministic guards on AI routing.** An `ai.router` node picks its branch from order text the customer controls, so a crafted title or note can steer it towards a route like auto-approve. The answer is already limited to the configured routes; routes that skip a person (approval, credit or risk review) should also need conditions checked in code, such as a total under a threshold or a known customer, before the model's choice is taken.
- **Smaller live updates on the order page.** Every OrderAgent `setState` broadcasts the whole state, the static `flow` graph and a 400-entry timeline included, four to six times per node. Sending the flow once and coalescing a node's reports into one update would cut socket traffic, but it changes the Workflow-to-agent reports and the state the order page reads, so it needs its own change.
- **Release approval.** Production deploys run in the `production` GitHub environment. Adding a required reviewer there would hold each merge to `main` until someone approves its deploy.
- **Clear out the old test orders' documents.** Migration 0027 deleted the four test orders production ran on demo data, but their invoices and purchase orders are still in the `orderloop-docs` R2 bucket under `orders/<id>/`, unreferenced. A one-off delete of those prefixes finishes the cleanup.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
