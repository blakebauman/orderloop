# Product editor

The plan for the catalog's product editor: a board where catalog staff fix what feed imports leave
broken or missing, have the assistant draft content, and publish on purpose. This page is the
engine plan, PR by PR. Each section says whether it is built; update it in the same change as the
code, and fold a finished section into [Architecture](architecture.md) and
[Data model](data-model.md) once it ships.

## What it does

- **Overrides survive imports.** A feed writes whole products (`CatalogShard.apply`), so an edit
  made in Order Loop would be wiped by the next import. Edits are kept per product, field and locale
  and re-applied over every import. Each override records the feed value it was made against; when
  an import changes that value, the override is a **conflict**: it stays live (the person's text is
  not silently undone) and the product returns to the board's Gaps column until someone keeps the
  override, takes the feed value or writes new text. An API `putProducts` counts as feed input too,
  so it can't overwrite an overridden field either; it makes a conflict.
- **Changes are staged.** Edits and accepted assistant drafts collect as pending changes and go live
  only when a person publishes them (up to `MAX_WRITE`, 500 products, at a time) through the shard's
  transaction and outbox, like every catalog write. A staged edit records the live value it was
  made against; a product whose value changed since (a feed, another person) is refused and stays
  staged with why. Resolving a conflict is an edit too: restage the same text to keep it (its base
  moves to the feed's new value), `clear` to take the feed's, or stage new text.
- **Gaps are indexed.** Per product: a title missing in a locale of a channel it is visible in;
  a description, localized text attribute or media alt text that has a value in some locale but not
  that one; rows a feed rejected (`missing_required` when the issue was a required attribute, which a
  stored product always has); conflicts.
- **The assistant drafts, never writes.** `draft_product_content` drafts per field and locale from
  the product's own data. Drafts are stored with the product (the board's Drafted column), each
  with the live value it was drafted against: it is stale once that field changes. Accepting one
  is staging it (`stageEdits` with `source: 'assistant'`, as the person); staging any edit to the
  field consumes its draft. Status isn't drafted.

Content only in the first version: title, description, slug, product-scoped localized text
attributes and product media alt text, per locale, and status. Variants, prices, channels,
categories and media stay with the feed. Viewer reads, operator writes and publishes, admin rebuilds
the gap index; every write is in the audit log.

## Where the state lives

In the `CatalogShard` that owns the product (`productShard(key)`), in tables created in the
constructor like the shard's others. No new Durable Object class, queue, bucket or KV namespace, no
D1 migration, and no change to `routing.ts` or `DOC_FORMAT`: overrides produce a `ProductData` of
the same shape, rendered by the unchanged `renderForChannel`.

| Table | Holds |
|---|---|
| `feed_rows` | The feed's own version of a product, only while it has overrides (otherwise `products.body` is the feed version) |
| `overrides` | Live edits: `(key, field, locale)`, the value (`null` removes the feed's), `base` (the feed value it was made against), `conflict` (a newer feed value), source, who and when |
| `staged` | Pending edits (`set` or `clear`) with the live value the person saw, and a failure reason after a refused publish |
| `drafts` | Unaccepted assistant drafts, with the field's live value they were drafted against (stale when it changes) |
| `gaps` | `(key, kind, field, locale, channel)`, rewritten in every transaction that changes the product |
| `rejections` | The last feed row refused for a key, with its issues |
| `board` | One row per product on the board: its column (conflicts and gaps → Gaps, then Staged, Drafted, Published for a day) and counts; staged counts and failures are read from `staged` |
| `revisions` | Per-field history for the sheet, the last 50 per key |

Board counts and pages fan out from `CatalogApi` to the 64 shards and are summed or merged there,
as `using()` does, so no shard awaits another. A column pages in key order. All of them
exist now (their columns in [Data model](data-model.md#product-catalog)).

## PRs

| # | PR | Status |
|---|---|---|
| 1 | Core content model: `packages/core/src/product/content.ts` (`FieldRef`, `fieldId`, `fieldValue`, `applyOverrides`, `editIssues`, `contentGaps`, `GAP_KINDS`), pure, tested in `product-content.test.ts` | Built |
| 2 | Shard: gap index, keyed feed rejections (a `rejectedKey` R2 object per part, which an older Worker ignores), the board table; RPC `catalogBoard`, `listBoard`, `rebuildGaps`; a channel change has each shard's alarm rebuild its gaps (`markGapsStale`, `GAP_REBUILD_DELAY_MS`). A per-feed gap count (`FeedStatus.gaps`) was left out: the board shows the live total | Built |
| 3 | Shard: `feed_rows`, `overrides`, `staged` and `revisions`, with `apply` applying overrides over feed rows and indexing `conflict`s (`overrideConflict`); `stageEdits`, `discardStaged`, `publishStaged` (idempotent per request, `Promise.allSettled` across shards so one shard's failure leaves only its products staged), `getProductSheet`; the board's Staged and Published columns | Built |
| 4 | Drafts: `putDrafts`, `discardDrafts`, accepting through `stageEdits` (which consumes the field's draft); the board's Drafted column and `drafts` counts; drafts on the sheet | Built |
| 5 | Web API under `/api/v1/catalog` (`board`, `board/:column`, `products/:key/sheet`, `edits`, `edits/discard`, `edits/publish`, `drafts`, `drafts/discard`, `gaps/rebuild`) with audit actions (`catalog.edits_*`, `catalog.drafts_*`, `catalog.gaps_rebuilt`) and OpenAPI | Built |
| 6 | A `CATALOG` service binding for the engine (`apps/engine/wrangler.jsonc`, `renderEngine` in `scripts/fleet.ts`); the catalog deploys before the engine | Built |
| 7 | `draft_product_content`: core tool (`ASSISTANT_TOOLS`, operator, no confirm; `draftTargets`, `MAX_DRAFT_FIELDS`), engine executor (`assistant/product-draft.ts`) through `runJson` with the product in a `dataBlock`, saving with `putDrafts` over `CATALOG`; `EngineRpc.draftProductContent`; the web route `POST /api/v1/catalog/products/:key/draft`. The engine saves the drafts on every path (the tool, MCP, A2A, the RPC); the web route audits its own calls, the engine the others | Built |
| 8 | Backfill without a manual step: a shard holding products from before the gap index (no `gaps_built`) queues the alarm's resumable rebuild for itself as it wakes (`CatalogShard.backfillGaps`), so it ships through CI; `POST /api/v1/catalog/gaps/rebuild` stays for recounting now | Built |

The board UI follows PRs 5 and 7. Its design brief is the surface brief for `app/routes/catalog.tsx`.

## Decisions

- "The last feed" on the board is the most recent finished import; a running one shows separately.
- An override can be cleared back to the feed value (a staged `clear`).
- Media alt text is keyed by `src`: a feed that renames an image makes its alt override a conflict.
- Whether **Published today** gets an undo (republishing the previous revision) is open.
