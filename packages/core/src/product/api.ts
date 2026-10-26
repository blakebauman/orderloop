/**
 * The product catalog's RPC contract: what the web app (and the engine) call on the catalog
 * Worker's `CatalogApi` entrypoint over a service binding. Callers never import catalog source.
 */

import type { FieldRef, Gap, GapKind } from './content';
import type {
  Category,
  CategoryInput,
  Channel,
  Product,
  ProductData,
  ProductInput,
  ProductType,
  ProductTypeInput,
} from './model';
import type { Issue } from './validate';

export type WriteStatus = 'created' | 'updated' | 'unchanged' | 'deleted' | 'rejected';

export type WriteResult = {
  key: string;
  status: WriteStatus;
  version?: number;
  issues?: Issue[];
};

export type WriteOptions = {
  /** Who made the change, for the audit trail. */
  by: string;
  /**
   * Purge cached copies now instead of letting them expire (about a minute). Purges are rationed,
   * so use it for changes that must not be seen late: a takedown, a price correction.
   */
  urgent?: boolean;
};

export const FEED_FORMATS = ['csv', 'ndjson'] as const;
export type FeedFormat = (typeof FEED_FORMATS)[number];
export const FEED_STATES = [
  'queued',
  'splitting',
  'applying',
  'done',
  'failed',
  'cancelled',
] as const;
export type FeedState = (typeof FEED_STATES)[number];

/** One message on the purge queue: cache tags catalog-edge purges (rationed, ~5 calls a minute). */
export type PurgeMessage = { tags: string[] };

/** Products a feed step reads before handing off to the next step. */
export const FEED_CHUNK = 25_000;
/** Rejected rows a feed keeps the reasons of. */
export const FEED_ERRORS = 100;

export type FeedStatus = {
  id: string;
  name: string;
  format: FeedFormat;
  state: FeedState;
  by: string;
  createdAt: number;
  finishedAt?: number;
  /** Rows read from the file. */
  rows: number;
  /** Parts the rows were split into, and how many have been applied. */
  parts: number;
  partsDone: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  /** The first rejected rows, with why. */
  errors: { row: number; key?: string; message: string }[];
  /** Why the feed failed as a whole, when `state` is `failed`. */
  failure?: string;
  /** Who cancelled it, when `state` is `cancelled`. */
  cancelledBy?: string;
};

/** Admin writes answer with what was stored, or why nothing was. */
export type Result<T> = ({ ok: true } & T) | { ok: false; issues: string[] };
export type TypeResult = Result<{ type: ProductType }>;
export type ChannelResult = Result<{ channel: Channel }>;
export type CategoriesResult = Result<{ categories: Category[] }>;
/** A refused delete says whether there was nothing to delete (`notFound`) or it's still in use. */
export type DeleteResult<T> = ({ ok: true } & T) | { ok: false; issues: string[]; notFound?: true };
export type DeleteTypeResult = DeleteResult<{ code: string; versions: number }>;
export type DeleteChannelResult = DeleteResult<{ code: string; unpublished: number }>;
export type DeleteCategoriesResult = DeleteResult<{ deleted: string[] }>;

/**
 * The product editor's board: products move from Gaps (missing content, rejected feed rows,
 * conflicts) through Drafted (assistant drafts to review) and Staged to Published (in the last
 * day). See docs/product-editor.md.
 */
export const BOARD_COLUMNS = ['gaps', 'drafted', 'staged', 'published'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** A feed row (or API write) the catalog refused for a product key, with why. */
export type Rejection = {
  /** The feed it came from; absent for an API write. */
  feed?: string;
  /** Its row in the feed file. */
  row?: number;
  issues: Issue[];
  at: number;
};

/** One product on the board. */
export type BoardCard = {
  key: string;
  /** The product's title (any locale), the rejected row's, or the key. */
  title: string;
  column: BoardColumn;
  /** Its gaps by kind. */
  kinds: Partial<Record<GapKind, number>>;
  rejection: Rejection | null;
  /** Edits staged for it, in any column. */
  staged: number;
  /** Assistant drafts waiting for review, in any column. */
  drafts: number;
  /** Why its staged edits didn't publish last time, if they didn't. */
  failure: string | null;
  /** When it joined this column. */
  at: number;
};

/** Who an edit came from: a person, or an assistant draft a person accepted. */
export const EDIT_SOURCES = ['person', 'assistant'] as const;
export type EditSource = (typeof EDIT_SOURCES)[number];

/**
 * An edit to stage: set a value (null removes the feed's value in that locale), or clear the
 * override so the feed's value shows again. Nothing goes live until it is published.
 */
export type StageEdit = { key: string; ref: FieldRef; source?: EditSource } & (
  | { op: 'set'; value: string | null }
  | { op: 'clear' }
);

export type EditResult =
  | { key: string; ref: FieldRef; ok: true }
  | { key: string; ref: FieldRef; ok: false; issues: string[] };

/** An edit waiting to publish, with the value the person saw when they staged it. */
export type StagedEdit = {
  ref: FieldRef;
  op: 'set' | 'clear';
  value: string | null;
  seen: string | null;
  source: EditSource;
  by: string;
  at: number;
  /** Why it didn't publish last time. */
  failure: string | null;
};

/**
 * An assistant draft for one field and locale. Never live: a person accepts it by staging it
 * (`stageEdits` with `source: 'assistant'`), and staging any edit to the field consumes it.
 */
export type DraftInput = { key: string; ref: FieldRef; value: string; model?: string };

/** A stored draft, with the live value it was drafted against. */
export type Draft = {
  ref: FieldRef;
  value: string;
  seen: string | null;
  /** The field's live value has changed since it was drafted. */
  stale: boolean;
  model: string | null;
  /** Who asked for it. */
  by: string;
  at: number;
};

/** A live override, with the feed value it was made against and the feed's value now. */
export type FieldOverride = {
  ref: FieldRef;
  value: string | null;
  base: string | null;
  feed: string | null;
  /** The feed changed the value since the override was made (`overrideConflict`). */
  conflict: boolean;
  source: EditSource;
  by: string;
  at: number;
};

/** One published change to a field: the last 50 per product are kept. */
export type Revision = {
  ref: FieldRef;
  op: 'set' | 'clear';
  value: string | null;
  previous: string | null;
  source: EditSource;
  by: string;
  at: number;
};

/** Everything the editor's sheet shows for one product. */
export type ProductSheet = {
  /** As it is live: the feed's version with the overrides applied. */
  product: Product;
  /** As the last feed (or API write) sent it. */
  feed: ProductData;
  overrides: FieldOverride[];
  staged: StagedEdit[];
  drafts: Draft[];
  gaps: Gap[];
  rejection: Rejection | null;
  /** Newest first. */
  revisions: Revision[];
};

/**
 * What publishing did with a product's staged edits: published them all, published none (with
 * why, and they stay staged), or there was nothing staged.
 */
export type PublishResult = {
  key: string;
  status: 'published' | 'failed' | 'unchanged';
  version?: number;
  issues?: string[];
};

export type BoardSummary = {
  /** Products in each column. */
  columns: Record<BoardColumn, number>;
  /** Gaps of each kind, and how many products have one. */
  gapsByKind: Partial<Record<GapKind, { gaps: number; products: number }>>;
  /** The most recent finished feed, and one still running. */
  lastFeed: FeedStatus | null;
  runningFeed: FeedStatus | null;
  /**
   * False until every shard has indexed the gaps of the products it held before the index existed
   * (`rebuildGaps`); until then the board can miss some.
   */
  indexBuilt: boolean;
};

export interface ProductCatalogRpc {
  /** Validates and stores products; unchanged ones write nothing. At most 500 per call. */
  putProducts(items: ProductInput[], opts: WriteOptions): Promise<WriteResult[]>;
  deleteProducts(keys: string[], opts: WriteOptions): Promise<WriteResult[]>;
  /** The stored product, as written (not a published document). */
  getProduct(key: string): Promise<Product | null>;
  /** The product that claims a SKU, GTIN or slug (`sku:ABC`, `gtin:…`, `slug:en:…`). */
  resolveAlias(alias: string): Promise<string | null>;

  /** Adds a type, or its next version; a new version may only add (see `typeChangeIssues`). */
  putType(type: ProductTypeInput, by: string): Promise<TypeResult>;
  /** Removes every version of a type; refused while any product uses it. */
  deleteType(code: string, by: string): Promise<DeleteTypeResult>;
  /** Latest version of every type. */
  listTypes(): Promise<ProductType[]>;
  /** A changed currency or locale list reaches published documents on the next reindex. */
  putChannel(channel: Channel, by: string): Promise<ChannelResult>;
  /**
   * Removes a channel and takes down everything published in it (documents, alias pointers,
   * cards, listings, search, category trees). Products keep their listing data for it.
   */
  deleteChannel(code: string, by: string): Promise<DeleteChannelResult>;
  listChannels(): Promise<Channel[]>;
  /** Upserts categories; the tree is republished once per call. */
  putCategories(categories: CategoryInput[], by: string): Promise<CategoriesResult>;
  /** Removes categories; refused while one has children outside the set or products in it. */
  deleteCategories(codes: string[], by: string): Promise<DeleteCategoriesResult>;
  listCategories(): Promise<Category[]>;

  /** Stores the feed and starts applying it in the background. */
  startFeed(
    body: ReadableStream<Uint8Array>,
    meta: { name: string; format: FeedFormat; by: string },
  ): Promise<FeedStatus>;
  feedStatus(id: string): Promise<FeedStatus | null>;
  /**
   * Stops a feed that hasn't finished: it splits no more of its file, and parts already sent to
   * the shards still apply. A finished feed is returned as it is; null when there's no such feed.
   */
  cancelFeed(id: string, by: string): Promise<FeedStatus | null>;
  /** Most recent first. */
  listFeeds(limit?: number): Promise<FeedStatus[]>;
  /**
   * Republishes every product (after a document format, channel or renderer change): each shard
   * queues all its products for its publisher. Returns how many were queued.
   */
  reindex(by: string): Promise<{ queued: number }>;

  /** The board's counts and the latest feeds. */
  catalogBoard(): Promise<BoardSummary>;
  /** One column's products in key order, `limit` (at most 100, default 50) after `cursor`. */
  listBoard(q: {
    column: BoardColumn;
    kind?: GapKind;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: BoardCard[]; cursor: string | null }>;
  /**
   * Recomputes every product's content gaps (after a channel's locales change, or to build the
   * index for products stored before it). Returns how many products it read.
   */
  rebuildGaps(by: string): Promise<{ products: number }>;

  /** A product's live and feed versions, overrides, staged edits, gaps and history; null if none. */
  getProductSheet(key: string): Promise<ProductSheet | null>;
  /**
   * Stages edits (at most 500 per call), each checked against the product as it is live. A later
   * edit to the same field and locale replaces the earlier one, and consumes its draft.
   */
  stageEdits(edits: StageEdit[], by: string): Promise<EditResult[]>;
  /**
   * Stores assistant drafts (at most 500 per call), each checked like an edit against the product
   * as it is live; status isn't drafted. A later draft to the same field and locale replaces the
   * earlier one. Nothing is staged or published.
   */
  putDrafts(drafts: DraftInput[], by: string): Promise<EditResult[]>;
  /** Drops drafts: one field's, or with no `ref` all of a product's. Returns how many. */
  discardDrafts(
    items: { key: string; ref?: FieldRef }[],
    by: string,
  ): Promise<{ discarded: number }>;
  /** Drops staged edits: one field's, or with no `ref` all of a product's. Returns how many. */
  discardStaged(
    items: { key: string; ref?: FieldRef }[],
    by: string,
  ): Promise<{ discarded: number }>;
  /**
   * Publishes the staged edits of up to 500 products, each product's all or none: one is refused
   * when a value it changes was changed by someone else since it was staged, or an edit no longer
   * fits. Calling again with the same `requestId` returns the first answer and publishes nothing.
   */
  publishStaged(
    keys: string[],
    opts: { by: string; requestId: string; urgent?: boolean },
  ): Promise<PublishResult[]>;
}
