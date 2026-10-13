# Roadmap

Planned work, roughly in priority order. Most of it ports ideas from commerceworker, as a node, a connector or an API surface; the flow model stays unchanged.

## Next

Nothing is scheduled. Candidates:

- **Sign in with an outside identity provider.** Users already carry `external_sub`; an OpenID Connect login could match people by subject and start the same session.
- **Rate-limit sign-in.** Failed sign-ins cost a PBKDF2 derivation each but aren't throttled.

## Not planned

These are platform concerns that Order Loop doesn't have: multi-tenancy, hostname dispatch and edge caching, Postgres with Hyperdrive, a control plane with billing, PIM and supplier catalog ingest, GraphQL parity, and plan or feature gating. Workers for Platforms merchant functions could one day become a sandboxed "custom code" node, but that would be its own project.
