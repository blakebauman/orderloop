/**
 * Listing indexes: one ListingIndexer Durable Object per channel and category keeps who is listed
 * there, and rebuilds the category's binary index (core's listing index) into R2 for catalog-edge.
 *
 * The shards' publisher sends a ListingChange per product and channel to the changes queue. The
 * consumer (`applyChanges`) expands categories to their ancestors (a product in Tees is listed in
 * Tops too), so a change reaches every listing it enters or leaves. Changes arrive at least once
 * and in any order: an indexer keeps the latest by `at`, and a removal leaves a tombstone so a late
 * older change can't bring a product back.
 *
 * Members are stored normalized (a row per member, per term value, per number), and a build streams
 * them column by column into ListingIndexBuilder, so a category of a million members builds without
 * ever holding a million objects. Builds wait at least DEBOUNCE_MS after the last one, so a feed
 * touching a category ten thousand times rebuilds it a handful of times.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  DOC_FORMAT,
  type IndexEntry,
  ListingIndexBuilder,
  listingSpec,
  paths,
  type SearchEntry,
} from '@orderloop/core/product';
import { indexer, meta } from './config';

/** One product's state in one channel's listings, from the publisher. */
export type ListingChange = {
  channel: string;
  key: string;
  /** When it was published; the latest wins. */
  at: number;
  /** What it lists as now, or null when it no longer lists in the channel. */
  entry: IndexEntry | null;
  /** The categories it was listed in before this change. */
  left: string[];
  /** What search indexes, per locale; null when it no longer lists in the channel. */
  search: (SearchEntry & { locale: string })[] | null;
};

type Item = { key: string; at: number; entry: IndexEntry | null };

/** Minimum time between two builds of one listing. */
export const DEBOUNCE_MS = 15_000;
/** Tombstones are kept long enough to outlive any redelivered change. */
const TOMBSTONE_MS = 24 * 60 * 60 * 1000;

const CATEGORY_TTL_MS = 30_000;
let parentsCache: { at: number; parents: Map<string, string | null> } | undefined;

async function categoryParents(env: Env): Promise<Map<string, string | null>> {
  if (parentsCache && Date.now() - parentsCache.at < CATEGORY_TTL_MS) return parentsCache.parents;
  const categories = await meta(env).listCategories();
  parentsCache = { at: Date.now(), parents: new Map(categories.map((c) => [c.code, c.parent])) };
  return parentsCache.parents;
}

/** `codes` and all their ancestors. A moved category reaches old listings only on a reindex. */
export function withAncestors(codes: string[], parents: Map<string, string | null>): Set<string> {
  const out = new Set<string>();
  for (const code of codes) {
    let c: string | null | undefined = code;
    while (c && !out.has(c)) {
      out.add(c);
      c = parents.get(c);
    }
  }
  return out;
}

/** Routes a batch of changes to the listings they touch, one call per listing. */
export async function applyChanges(env: Env, changes: ListingChange[]): Promise<void> {
  const parents = await categoryParents(env);
  const groups = new Map<string, { channel: string; category: string; items: Item[] }>();
  const push = (channel: string, category: string, item: Item) => {
    const id = `${channel}:${category}`;
    const g = groups.get(id) ?? { channel, category, items: [] };
    g.items.push(item);
    groups.set(id, g);
  };
  for (const c of changes) {
    const now = withAncestors(c.entry?.categories ?? [], parents);
    for (const category of now) push(c.channel, category, { key: c.key, at: c.at, entry: c.entry });
    for (const category of withAncestors(c.left, parents))
      if (!now.has(category)) push(c.channel, category, { key: c.key, at: c.at, entry: null });
  }
  await Promise.all(
    [...groups.values()].map((g) =>
      indexer(env, g.channel, g.category).apply(g.channel, g.category, g.items),
    ),
  );
}

export class ListingIndexer extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (
        key TEXT PRIMARY KEY, uid INTEGER, at INTEGER NOT NULL, created_at INTEGER, live INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS members_order ON members (live, created_at DESC, uid);
      CREATE TABLE IF NOT EXISTS terms (uid INTEGER NOT NULL, attr TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS terms_attr ON terms (attr, value);
      CREATE INDEX IF NOT EXISTS terms_uid ON terms (uid);
      CREATE TABLE IF NOT EXISTS nums (uid INTEGER NOT NULL, attr TEXT NOT NULL, value REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS nums_attr ON nums (attr, uid);
      CREATE INDEX IF NOT EXISTS nums_uid ON nums (uid);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  private setting(k: string): string | undefined {
    return this.sql.exec<{ v: string }>('SELECT v FROM settings WHERE k = ?', k).toArray()[0]?.v;
  }

  private set(k: string, v: string | number) {
    this.sql.exec('INSERT OR REPLACE INTO settings VALUES (?, ?)', k, String(v));
  }

  private clear(uid: number) {
    this.sql.exec('DELETE FROM terms WHERE uid = ?', uid);
    this.sql.exec('DELETE FROM nums WHERE uid = ?', uid);
  }

  async apply(channel: string, category: string, items: Item[]): Promise<void> {
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      if (!this.setting('channel')) {
        this.set('channel', channel);
        this.set('category', category);
      }
      for (const item of items) {
        const row = this.sql
          .exec<{ at: number; uid: number | null }>(
            'SELECT at, uid FROM members WHERE key = ?',
            item.key,
          )
          .toArray()[0];
        if (row && row.at >= item.at) continue;
        if (row?.uid !== null && row?.uid !== undefined) this.clear(row.uid);
        changed = true;
        const e = item.entry;
        if (!e) {
          this.sql.exec(
            'INSERT OR REPLACE INTO members VALUES (?, NULL, ?, NULL, 0)',
            item.key,
            item.at,
          );
          continue;
        }
        this.sql.exec(
          'INSERT OR REPLACE INTO members VALUES (?, ?, ?, ?, 1)',
          item.key,
          e.uid,
          item.at,
          e.createdAt,
        );
        for (const [attr, values] of Object.entries(e.terms))
          for (const v of values)
            this.sql.exec('INSERT INTO terms VALUES (?, ?, ?)', e.uid, attr, v);
        for (const [attr, values] of Object.entries(e.numbers))
          for (const v of values)
            this.sql.exec('INSERT INTO nums VALUES (?, ?, ?)', e.uid, attr, v);
      }
      if (changed) this.set('dirty', 1);
    });
    if (changed && (await this.ctx.storage.getAlarm()) === null) {
      const last = Number(this.setting('built') ?? 0);
      await this.ctx.storage.setAlarm(Math.max(Date.now(), last + DEBOUNCE_MS));
    }
  }

  /** Listed members (tests and status). */
  count(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE live = 1').one().n;
  }

  override async alarm() {
    this.sql.exec('DELETE FROM members WHERE live = 0 AND at < ?', Date.now() - TOMBSTONE_MS);
    if (this.setting('dirty') !== '1') return;
    const channelCode = this.setting('channel') ?? '';
    const category = this.setting('category') ?? '';
    const config = await meta(this.env).getConfig();
    const channel = config.channels.find((c) => c.code === channelCode);
    // A channel that no longer exists keeps its last index; nothing new to build for it.
    if (!channel) return;
    const spec = listingSpec(config.types, channel);
    const builtAt = Date.now();
    this.set('dirty', 0);
    const bytes = this.build(spec, builtAt);
    await this.env.PUBLISHED.put(paths.listing(DOC_FORMAT, channelCode, category), bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { members: String(this.count()), builtAt: String(builtAt) },
    });
    this.set('built', builtAt);
    // Changes that arrived while building rebuild once more, after the debounce.
    if (this.setting('dirty') === '1') await this.ctx.storage.setAlarm(builtAt + DEBOUNCE_MS);
  }

  /** Streams the members into the builder, one column at a time. */
  private build(spec: ReturnType<typeof listingSpec>, builtAt: number): Uint8Array {
    const b = new ListingIndexBuilder(spec, builtAt);
    const n = this.count();
    const ids = new Uint32Array(n);
    let i = 0;
    for (const r of this.sql.exec<{ uid: number }>(
      'SELECT uid FROM members WHERE live = 1 ORDER BY created_at DESC, uid',
    ))
      ids[i++] = r.uid;
    b.ids(ids);
    // uid → member number, by binary search over the uids in ascending order.
    const order = new Uint32Array(n);
    for (let j = 0; j < n; j++) order[j] = j;
    order.sort((x, y) => (ids[x] as number) - (ids[y] as number));
    const sortedUids = Uint32Array.from(order, (j) => ids[j] as number);
    const member = (uid: number): number => {
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const v = sortedUids[mid] as number;
        if (v === uid) return order[mid] as number;
        if (v < uid) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    };

    for (const attr of spec.terms) {
      let value: string | undefined;
      let list: number[] = [];
      const flush = () => {
        if (value !== undefined && list.length) b.term(attr, value, Uint32Array.from(list).sort());
      };
      for (const r of this.sql.exec<{ value: string; uid: number }>(
        'SELECT value, uid FROM terms WHERE attr = ? ORDER BY value',
        attr,
      )) {
        if (r.value !== value) {
          flush();
          value = r.value;
          list = [];
        }
        const m = member(r.uid);
        if (m >= 0) list.push(m);
      }
      flush();
    }

    for (const attr of spec.numbers) {
      const counts = new Uint32Array(n);
      const pairs: number[] = [];
      for (const r of this.sql.exec<{ uid: number; value: number }>(
        'SELECT uid, value FROM nums WHERE attr = ?',
        attr,
      )) {
        const m = member(r.uid);
        if (m < 0) continue;
        counts[m] = (counts[m] as number) + 1;
        pairs.push(m, r.value);
      }
      if (!pairs.length) continue;
      const offsets = new Uint32Array(n + 1);
      for (let j = 0; j < n; j++) offsets[j + 1] = (offsets[j] as number) + (counts[j] as number);
      const flat = new Float64Array(offsets[n] as number);
      const fill = Uint32Array.from(offsets.subarray(0, n));
      for (let p = 0; p < pairs.length; p += 2) {
        const m = pairs[p] as number;
        flat[fill[m] as number] = pairs[p + 1] as number;
        fill[m] = (fill[m] as number) + 1;
      }
      b.numbers(attr, offsets, flat);
    }
    return b.finish();
  }
}
