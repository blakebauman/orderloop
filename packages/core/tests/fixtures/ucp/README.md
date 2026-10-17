# UCP schemas

The JSON Schemas of the Universal Commerce Protocol, copied unchanged from
`source/schemas/` of https://github.com/Universal-Commerce-Protocol/ucp at tag
`v2026-08-25` (commit `cd78fb3`), under the Apache License 2.0 (`LICENSE`).

`tests/ucp.test.ts` validates what OrderLoop serves (the business profile, checkout and order
responses) against them. To move to a new UCP version, replace this folder with that tag's
`source/schemas/` and update `UCP_VERSION` in `src/ucp/errors.ts`.
