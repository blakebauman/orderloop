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
  type CategoriesResult,
  type Category,
  type CategoryInput,
  type Channel,
  type ChannelResult,
  type DeleteCategoriesResult,
  type DeleteChannelResult,
  type DeleteTypeResult,
  DOC_FORMAT,
  FEED_FORMATS,
  type FeedFormat,
  type FeedStatus,
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
    return shard(this.env, aliasShard(alias)).owner(alias);
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
    const status = await feeds(this.env).create({
      id,
      name: m.name.slice(0, 200),
      format: m.format,
      by: m.by,
    });
    await this.env.FEED_IMPORT.create({ id, params: { id, format: m.format, key, by: m.by } });
    return status;
  }

  async feedStatus(id: string): Promise<FeedStatus | null> {
    return feeds(this.env).get(id);
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
    await Promise.all(
      channels.flatMap((ch) =>
        unique.map((c) => this.env.PUBLISHED.delete(paths.listing(DOC_FORMAT, ch.code, c))),
      ),
    );
    return { ok: true, deleted: r.categories.map((c) => c.code) };
  }
}
