/**
 * CatalogApi: the catalog's RPC entrypoint (ProductCatalogRpc in core), reached over service
 * bindings only. It validates products against the types they name, groups them by shard and
 * sends each shard one batch; it never touches storage itself.
 *
 * A feed is stored in R2 as it streams in, then imported by the FeedImport Workflow
 * (feed-import.ts); its progress is kept by CatalogFeeds.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { newId } from '@orderloop/core';
import {
  aliasShard,
  BOARD_COLUMNS,
  type BoardCard,
  type BoardColumn,
  type BoardSummary,
  type CategoriesResult,
  type Category,
  type CategoryInput,
  type Channel,
  type ChannelResult,
  claimedAlias,
  type DeleteCategoriesResult,
  type DeleteChannelResult,
  type DeleteTypeResult,
  DOC_FORMAT,
  FEED_FORMATS,
  type FeedFormat,
  type FeedStatus,
  type GapKind,
  LISTING_SEGMENTS,
  PRODUCT_SHARDS,
  type Product,
  type ProductCatalogRpc,
  type ProductData,
  type ProductInput,
  type ProductType,
  type ProductTypeInput,
  paths,
  productShard,
  type TypeResult,
  validateProduct,
  type WriteOptions,
  type WriteResult,
} from '@orderloop/core/product';
import { type CatalogConfig, feeds, meta, shard, shardFor, typeResolver } from './config';
import { storeStream } from './upload';

/** Products per putProducts call. */
export const MAX_WRITE = 500;
/** Cards per board page, at most. */
const BOARD_PAGE_MAX = 100;
/** Products a shard re-reads per gap rebuild call. */
const GAP_REBUILD_PAGE = 500;
const RUNNING: FeedStatus['state'][] = ['queued', 'splitting', 'applying'];
/**
 * How long an isolate trusts its copy of the config. A product naming a type without a version gets
 * the latest this isolate has seen: at most this old, and always valid (versions only add).
 */
const CONFIG_TTL_MS = 2_000;

let cached: { config: CatalogConfig; at: number } | undefined;

export class CatalogApi extends WorkerEntrypoint<Env> implements ProductCatalogRpc {
  private async config(fresh = false): Promise<CatalogConfig> {
    if (!fresh && cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
    cached = { config: await meta(this.env).getConfig(), at: Date.now() };
    return cached.config;
  }

  async putProducts(items: ProductInput[], opts: WriteOptions): Promise<WriteResult[]> {
    if (items.length > MAX_WRITE) throw new RangeError(`at most ${MAX_WRITE} products per call`);
    let config = await this.config();
    let validated = items.map((item) => validateProduct(item, typeResolver(config)));
    // A type added a moment ago may not be in this isolate's copy yet: look once more.
    if (validated.some((v) => !v.ok && v.issues[0]?.path === 'type')) {
      config = await this.config(true);
      validated = items.map((item) => validateProduct(item, typeResolver(config)));
    }
    const results: WriteResult[] = new Array(items.length);
    const groups = new Map<number, { i: number; data: ProductData }[]>();
    validated.forEach((v, i) => {
      if (!v.ok) {
        const key = (items[i] as { key?: unknown } | undefined)?.key;
        results[i] = {
          key: typeof key === 'string' ? key : '',
          status: 'rejected',
          issues: v.issues,
        };
        return;
      }
      const n = productShard(v.data.key);
      const list = groups.get(n) ?? [];
      list.push({ i, data: v.data });
      groups.set(n, list);
    });
    await Promise.all(
      [...groups].map(async ([n, rows]) => {
        const out = await shard(this.env, n).apply({
          shard: n,
          batchId: crypto.randomUUID(),
          rows: rows.map((r) => r.data),
          rev: config.rev,
          by: opts.by,
          urgent: opts.urgent,
        });
        out.forEach((r, j) => {
          results[(rows[j] as { i: number }).i] = r;
        });
      }),
    );
    return results;
  }

  async deleteProducts(keys: string[], opts: WriteOptions): Promise<WriteResult[]> {
    if (keys.length > MAX_WRITE) throw new RangeError(`at most ${MAX_WRITE} products per call`);
    const groups = new Map<number, number[]>();
    keys.forEach((k, i) => {
      const n = productShard(k);
      const list = groups.get(n) ?? [];
      list.push(i);
      groups.set(n, list);
    });
    const results: WriteResult[] = new Array(keys.length);
    await Promise.all(
      [...groups].map(async ([n, idx]) => {
        const out = await shard(this.env, n).remove({
          shard: n,
          keys: idx.map((i) => keys[i] as string),
          by: opts.by,
          urgent: opts.urgent,
        });
        out.forEach((r, j) => {
          results[idx[j] as number] = r;
        });
      }),
    );
    return results;
  }

  async getProduct(key: string): Promise<Product | null> {
    // Typed through the contract: wrangler's RPC type mapping can't follow JSON attribute values.
    const stub = shardFor(this.env, key) as unknown as {
      get(key: string): Promise<Product | null>;
    };
    return stub.get(key);
  }

  async resolveAlias(alias: string): Promise<string | null> {
    // A GTIN in any length is claimed as its GTIN-14.
    const claimed = claimedAlias(alias);
    return claimed ? shard(this.env, aliasShard(claimed)).owner(claimed) : null;
  }

  async putType(type: ProductTypeInput, by: string): Promise<TypeResult> {
    const result = await meta(this.env).putType(type, by);
    cached = undefined;
    return result;
  }

  async listTypes(): Promise<ProductType[]> {
    return meta(this.env).listTypes();
  }

  async putChannel(channel: Channel, _by: string): Promise<ChannelResult> {
    const result = await meta(this.env).putChannel(channel);
    cached = undefined;
    // A channel's locales decide which content is missing: every shard recounts its gaps.
    if (result.ok) await this.markGapsStale();
    return result;
  }

  async listChannels(): Promise<Channel[]> {
    return meta(this.env).channels();
  }

  async putCategories(categories: CategoryInput[], _by: string): Promise<CategoriesResult> {
    return meta(this.env).putCategories(categories);
  }

  async listCategories(): Promise<Category[]> {
    return meta(this.env).listCategories();
  }

  async startFeed(
    body: ReadableStream<Uint8Array>,
    m: { name: string; format: FeedFormat; by: string },
  ): Promise<FeedStatus> {
    if (!FEED_FORMATS.includes(m.format))
      throw new RangeError(`format must be ${FEED_FORMATS.join(' or ')}`);
    const id = newId('feed');
    const key = `feeds/${id}/source.${m.format}`;
    await storeStream(this.env.PUBLISHED, key, body);
    // Once the file is stored, its record and its import start together even if the caller has
    // gone meanwhile: cancelled between the two, a feed would stay queued with nothing to run it.
    const started = (async () => {
      const status = await feeds(this.env).create({
        id,
        name: m.name.slice(0, 200),
        format: m.format,
        by: m.by,
      });
      try {
        await this.env.FEED_IMPORT.create({ id, params: { id, format: m.format, key, by: m.by } });
      } catch (err) {
        // Nothing will run it: say so rather than leave it queued.
        await feeds(this.env).fail(
          id,
          `import didn't start: ${err instanceof Error ? err.message : err}`,
        );
        throw err;
      }
      return status;
    })();
    this.ctx.waitUntil(
      started.catch((err) =>
        console.error(JSON.stringify({ type: 'feed_start_failed', id, error: String(err) })),
      ),
    );
    return started;
  }

  async feedStatus(id: string): Promise<FeedStatus | null> {
    return feeds(this.env).get(id);
  }

  async cancelFeed(id: string, by: string): Promise<FeedStatus | null> {
    const status = await feeds(this.env).cancel(id, by);
    if (status?.state === 'cancelled')
      try {
        await (await this.env.FEED_IMPORT.get(id)).terminate();
      } catch {
        // No instance (it never started) or it has already stopped: the state is what counts.
      }
    return status;
  }

  async listFeeds(limit = 20): Promise<FeedStatus[]> {
    return feeds(this.env).list(Math.min(Math.max(1, limit), 100));
  }

  async reindex(_by: string): Promise<{ queued: number }> {
    const counts = await Promise.all(
      Array.from({ length: PRODUCT_SHARDS }, (_, n) => shard(this.env, n).republishAll(n)),
    );
    return { queued: counts.reduce((a, b) => a + b, 0) };
  }

  async catalogBoard(): Promise<BoardSummary> {
    const [parts, recent] = await Promise.all([
      Promise.all(
        Array.from({ length: PRODUCT_SHARDS }, (_, n) => shard(this.env, n).boardCounts()),
      ),
      feeds(this.env).list(20),
    ]);
    const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, 0])) as Record<
      BoardColumn,
      number
    >;
    const gapsByKind: BoardSummary['gapsByKind'] = {};
    for (const p of parts) {
      for (const [c, n] of Object.entries(p.columns)) columns[c as BoardColumn] += n;
      for (const [k, v] of Object.entries(p.kinds)) {
        const sum = gapsByKind[k as GapKind] ?? { gaps: 0, products: 0 };
        sum.gaps += v.gaps;
        sum.products += v.products;
        gapsByKind[k as GapKind] = sum;
      }
    }
    return {
      columns,
      gapsByKind,
      lastFeed: recent.find((f) => f.state === 'done') ?? null,
      runningFeed: recent.find((f) => RUNNING.includes(f.state)) ?? null,
      indexBuilt: parts.every((p) => p.built),
    };
  }

  async listBoard(q: {
    column: BoardColumn;
    kind?: GapKind;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: BoardCard[]; cursor: string | null }> {
    if (!BOARD_COLUMNS.includes(q.column)) throw new RangeError(`no column ${q.column}`);
    const asked = Number.isFinite(q.limit) ? Math.trunc(q.limit as number) : 50;
    const limit = Math.min(Math.max(1, asked), BOARD_PAGE_MAX);
    // One more than a page from each shard: more than `limit` in all means there's another page.
    const pages = await Promise.all(
      Array.from({ length: PRODUCT_SHARDS }, (_, n) =>
        shard(this.env, n).boardPage({
          column: q.column,
          kind: q.kind,
          cursor: q.cursor,
          limit: limit + 1,
        }),
      ),
    );
    const all = (pages.flat() as BoardCard[]).sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    const items = all.slice(0, limit);
    return { items, cursor: all.length > limit ? (items.at(-1)?.key ?? null) : null };
  }

  /** Has every shard's alarm recompute its gaps (`CatalogShard.markGapsStale`). */
  private async markGapsStale(): Promise<void> {
    await Promise.all(
      Array.from({ length: PRODUCT_SHARDS }, (_, n) => shard(this.env, n).markGapsStale(n)),
    );
  }

  async rebuildGaps(_by: string): Promise<{ products: number }> {
    const counts = await Promise.all(
      Array.from({ length: PRODUCT_SHARDS }, async (_, n) => {
        let total = 0;
        let cursor: string | null = null;
        do {
          const r: { next: string | null; products: number } = await shard(this.env, n).refreshGaps(
            n,
            cursor,
            GAP_REBUILD_PAGE,
          );
          total += r.products;
          cursor = r.next;
        } while (cursor);
        return total;
      }),
    );
    return { products: counts.reduce((a, b) => a + b, 0) };
  }

  /** How many products, across every shard, use a type or are filed in a category. */
  private async using(q: { type?: string; category?: string }): Promise<number> {
    const counts = await Promise.all(
      Array.from({ length: PRODUCT_SHARDS }, (_, n) => shard(this.env, n).countUsing(q)),
    );
    return counts.reduce((a, b) => a + b, 0);
  }

  /** Deletes every R2 object under `prefix`, a listing page at a time. */
  private async sweep(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.env.PUBLISHED.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await this.env.PUBLISHED.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async deleteType(code: string, _by: string): Promise<DeleteTypeResult> {
    const n = await this.using({ type: code });
    if (n) return { ok: false, issues: [`${n} products use ${code}: delete or move them first`] };
    const { versions } = await meta(this.env).deleteType(code);
    cached = undefined;
    if (!versions) return { ok: false, issues: [`${code}: unknown type`], notFound: true };
    return { ok: true, code, versions };
  }

  async deleteChannel(code: string, _by: string): Promise<DeleteChannelResult> {
    // Out of the config first, so no shard publishes to it again; then take down what it had.
    // A channel already gone still gets the takedown: that's how a delete cut short is finished.
    const channel = await meta(this.env).deleteChannel(code);
    cached = undefined;
    const taken = await Promise.all(
      Array.from({ length: PRODUCT_SHARDS }, async (_, n) => {
        let total = 0;
        for (;;) {
          const k = await shard(this.env, n).forgetChannel(code, 500);
          if (!k) return total;
          total += k;
        }
      }),
    );
    // Listing indexes, and anything a crashed publish left behind.
    await this.sweep(`idx/${DOC_FORMAT}/${code}/`);
    await this.sweep(`docs/${DOC_FORMAT}/${code}/`);
    // Its locales no longer count: every shard recounts its gaps.
    await this.markGapsStale();
    const unpublished = taken.reduce((a, b) => a + b, 0);
    if (!channel && !unpublished)
      return { ok: false, issues: [`${code}: unknown channel`], notFound: true };
    return { ok: true, code, unpublished };
  }

  async deleteCategories(codes: string[], _by: string): Promise<DeleteCategoriesResult> {
    const unique = [...new Set(codes)];
    const counts = await Promise.all(unique.map((c) => this.using({ category: c })));
    const issues = unique.flatMap((c, i) =>
      counts[i] ? [`${c}: ${counts[i]} products are filed in it`] : [],
    );
    if (issues.length) return { ok: false, issues };
    const r = await meta(this.env).deleteCategories(unique);
    if (!r.ok) return r;
    const channels = await meta(this.env).channels();
    // Every segment of each listing, one call per listing (a delete takes up to 1,000 keys).
    await Promise.all(
      channels.flatMap((ch) =>
        unique.map((c) =>
          this.env.PUBLISHED.delete(
            Array.from({ length: LISTING_SEGMENTS }, (_, s) =>
              paths.listing(DOC_FORMAT, ch.code, c, s),
            ),
          ),
        ),
      ),
    );
    return { ok: true, deleted: r.categories.map((c) => c.code) };
  }
}
