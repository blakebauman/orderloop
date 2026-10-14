# Roadmap

Planned work, roughly in priority order. Most of it ports ideas from commerceworker, as a node, a connector or an API surface; the flow model stays unchanged.

## Next

Nothing is scheduled. Candidates:

- **More channel adapters.** Shopify orders and EDI X12 850 purchase orders are in. Still to come: Amazon (an SP-API notification consumer and order fetch), 997 functional acknowledgements for EDI, and AS2/SFTP transport so partners can send without a provider in between.
- **Concurrent seller responses.** A marketplace order waits for one `seller.responded` per pass of its acceptance loop, so a second seller who answers in the gap gets `409` (`delivered: false`) and has to retry. Buffering early responses on the order would let every reply land the first time.
- **Default timeouts from the catalog.** When an Approval or Wait-for-event node has no `timeout`, `workflow.ts` falls back to `7 days`; the catalog defaults are `2 days` and `30 days`. Only a flow stored without the field is affected, but the two should agree.
- **Stalled means waiting too long.** The assistant calls an order stalled when `orders.updated_at` is more than a day old, so an order that keeps updating while it waits looks healthy. Measuring from when the current wait opened would be truer.
- **Carry-out on the omnichannel flow, and undoing a hand-over.** `tpl-omnichannel-order` sends carry-out to its "Cannot fulfil" end (carry-out belongs to `tpl-pos-sale`), and `commerce.handover` has no rollback, so a failure after goods leave the store doesn't put the stock back.
- **Sign in with an outside identity provider.** Users already carry `external_sub`; an OpenID Connect login could match people by subject and start the same session.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
