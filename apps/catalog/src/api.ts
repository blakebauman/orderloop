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
}
