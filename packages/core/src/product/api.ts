/**
 * The product catalog's RPC contract: what the web app (and the engine) call on the catalog
 * Worker's `CatalogApi` entrypoint over a service binding. Callers never import catalog source.
 */

import type {
  Category,
  CategoryInput,
  Channel,
  Product,
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
export const FEED_STATES = ['queued', 'splitting', 'applying', 'done', 'failed'] as const;
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
  /** Most recent first. */
  listFeeds(limit?: number): Promise<FeedStatus[]>;
  /**
   * Republishes every product (after a document format, channel or renderer change): each shard
   * queues all its products for its publisher. Returns how many were queued.
   */
  reindex(by: string): Promise<{ queued: number }>;
}
