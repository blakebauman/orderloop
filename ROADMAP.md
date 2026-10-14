# Roadmap

Planned work, roughly in priority order. Most of it ports ideas from commerceworker, as a node, a connector or an API surface; the flow model stays unchanged.

## Next

Nothing is scheduled. Candidates:

- **More channel adapters.** Shopify orders and EDI X12 850 purchase orders are in. Still to come: Amazon (an SP-API notification consumer and order fetch), 997 functional acknowledgements for EDI, and AS2/SFTP transport so partners can send without a provider in between.
- **Sign in with an outside identity provider.** Users already carry `external_sub`; an OpenID Connect login could match people by subject and start the same session.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
