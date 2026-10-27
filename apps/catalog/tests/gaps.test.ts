import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type BoardCard,
  type FeedStatus,
  type GapKind,
  PRODUCT_SHARDS,
  productShard,
} from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, by, product, setup } from './helpers';

beforeAll(setup);

/** Every card in a column (following the cursor), and how many pages it took. */
async function column(kind?: GapKind, limit = 100) {
  const items: BoardCard[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await api.listBoard({ column: 'gaps', kind, cursor, limit });
    items.push(...page.items);
    cursor = page.cursor ?? undefined;
    pages++;
  } while (cursor);
  return { items, pages };
}

const card = async (key: string) => (await column()).items.find((c) => c.key === key);

function ndjson(lines: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n'));
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function finished(id: string): Promise<FeedStatus> {
  for (let i = 0; i < 300; i++) {
    const s = await api.feedStatus(id);
    if (s && s.state !== 'queued' && s.state !== 'splitting' && s.state !== 'applying') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`feed ${id} never finished`);
}

describe('content gaps on the board', () => {
  it('puts a product with missing content on Gaps, and takes it off once filled', async () => {
    const p = product({ description: { en: 'A cotton tee.' } });
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('created');
    expect(await card(p.key)).toMatchObject({
      key: p.key,
      title: p.title.en,
      column: 'gaps',
      kinds: { missing_description: 1 },
      rejection: null,
    });
    expect((await column('missing_description')).items.map((c) => c.key)).toContain(p.key);
    expect((await column('missing_title')).items.map((c) => c.key)).not.toContain(p.key);

    await api.putProducts([{ ...p, description: { en: 'A cotton tee.', fr: 'Un t-shirt.' } }], {
      by,
    });
    expect(await card(p.key)).toBeUndefined();
    // Every write since the shards were new kept the index: built without a rebuild.
    expect((await api.catalogBoard()).indexBuilt).toBe(true);
  });

  it('counts gaps and products by kind across shards', async () => {
    const before = await api.catalogBoard();
    const ps = Array.from({ length: 6 }, () => product({ title: { en: 'English only' } }));
    await api.putProducts(ps, { by });
    const after = await api.catalogBoard();
    expect(after.columns.gaps - before.columns.gaps).toBe(6);
    const was = before.gapsByKind.missing_title ?? { gaps: 0, products: 0 };
    expect(after.gapsByKind.missing_title).toEqual({
      gaps: was.gaps + 6,
      products: was.products + 6,
    });
    expect(after.columns).toMatchObject({ drafted: 0, staged: 0, published: 0 });
  });

  it('pages a column in key order across shards, with no repeats', async () => {
    const ps = Array.from({ length: 7 }, () => product({ title: { fr: 'Français seulement' } }));
    await api.putProducts(ps, { by });
    const { items, pages } = await column('missing_title', 2);
    const keys = items.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort());
    for (const p of ps) expect(keys).toContain(p.key);
    expect(pages).toBeGreaterThan(3);
  });

  it('writes nothing new for a product sent again unchanged', async () => {
    const p = product({ description: { en: 'Only English.' } });
    await api.putProducts([p], { by });
    const first = await card(p.key);
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('unchanged');
    expect(await card(p.key)).toEqual(first);
  });
});

describe('refused rows on the board', () => {
  it('records an API write refused for a taken SKU, until the key is written cleanly', async () => {
    const a = product();
    const b = product({ variants: [{ sku: a.variants[0]?.sku ?? '', attributes: { size: 'S' } }] });
    await api.putProducts([a], { by });
    expect((await api.putProducts([b], { by }))[0]?.status).toBe('rejected');
    const c = await card(b.key);
    expect(c).toMatchObject({ column: 'gaps', kinds: { rejected: 1 }, title: b.title.en });
    expect(c?.rejection?.issues[0]?.message).toMatch(/already used by/);
    expect(c?.rejection?.feed).toBeUndefined();

    await api.putProducts([product({ key: b.key, title: b.title })], { by });
    expect(await card(b.key)).toBeUndefined();
  });

  it("records a feed's refused rows against their keys, with the feed and row", async () => {
    const ok = product();
    const bad = product({ attributes: { material: 'silk' } });
    const started = await api.startFeed(ndjson([ok, bad]), {
      name: 'gaps.ndjson',
      format: 'ndjson',
      by,
    });
    const s = await finished(started.id);
    expect(s).toMatchObject({ state: 'done', created: 1, rejected: 1 });
    const c = await card(bad.key);
    expect(c).toMatchObject({ kinds: { rejected: 1 }, title: bad.title.en });
    expect(c?.rejection).toMatchObject({ feed: started.id, row: 2 });
    expect(c?.rejection?.issues[0]?.path).toBe('attributes.material');
    expect(await card(ok.key)).toBeUndefined();

    // Fixed in the next feed: off the board.
    const fixed = await api.startFeed(ndjson([{ ...bad, attributes: { material: 'wool' } }]), {
      name: 'fixed.ndjson',
      format: 'ndjson',
      by,
    });
    expect(await finished(fixed.id)).toMatchObject({ state: 'done', created: 1, rejected: 0 });
    expect(await card(bad.key)).toBeUndefined();
    expect((await api.catalogBoard()).lastFeed?.id).toBe(fixed.id);
  });

  it('files a refusal for a missing required attribute as its own kind', async () => {
    const t = await api.putType(
      {
        code: 'gadget',
        version: 1,
        attributes: [{ code: 'model', kind: 'text', required: true }],
      },
      by,
    );
    expect(t.ok).toBe(true);
    const g = product({ type: 'gadget', attributes: {} });
    g.variants = g.variants.slice(0, 1).map((v) => ({ sku: v.sku }));
    const started = await api.startFeed(ndjson([g]), { name: 'g.ndjson', format: 'ndjson', by });
    expect(await finished(started.id)).toMatchObject({ rejected: 1 });
    expect(await card(g.key)).toMatchObject({ kinds: { missing_required: 1 } });
  });

  it('skips a refusal older than the product it refers to, and clears one on an unchanged resend', async () => {
    const p = product();
    await api.putProducts([p], { by });
    const n = productShard(p.key);
    const refuse = (at: number, id: string) =>
      env.SHARD.getByName(`shard-${n}`).apply({
        shard: n,
        batchId: id,
        rows: [],
        rev: 0,
        by,
        feed: 'feed_test',
        rejected: [
          { key: p.key, title: 'Late', row: 9, issues: [{ path: 'x', message: 'bad' }], at },
        ],
      });
    // Split before the product was written, applied after it (parts apply out of order).
    await refuse(0, `old-${p.key}`);
    expect(await card(p.key)).toBeUndefined();
    // Refused after it: it stands until the key is sent again.
    await refuse(Date.now() + 60_000, `new-${p.key}`);
    expect(await card(p.key)).toMatchObject({ kinds: { rejected: 1 } });
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('unchanged');
    expect(await card(p.key)).toBeUndefined();
  });

  it('clears a key that only had refused rows when it is deleted', async () => {
    const a = product();
    const b = product({ variants: [{ sku: a.variants[0]?.sku ?? '', attributes: { size: 'S' } }] });
    // One after the other: in one call they claim the SKU at once, and either can win.
    await api.putProducts([a], { by });
    expect((await api.putProducts([b], { by }))[0]?.status).toBe('rejected');
    expect(await card(b.key)).toBeDefined();
    await api.deleteProducts([b.key], { by });
    expect(await card(b.key)).toBeUndefined();
  });
});

describe('rebuilding the index', () => {
  it("recounts gaps when a channel's locales change, and reports the index built", async () => {
    const p = product({
      channels: { web: { visible: true }, kiosk: { visible: true } },
    });
    await api.putProducts([p], { by });
    // `kiosk` didn't exist when the product was written: no gaps in it yet.
    expect(await card(p.key)).toBeUndefined();
    const ch = await api.putChannel(
      { code: 'kiosk', name: 'Kiosk', currency: 'USD', locales: ['en', 'de'], defaultLocale: 'en' },
      by,
    );
    expect(ch.ok).toBe(true);
    const r = await api.rebuildGaps(by);
    expect(r.products).toBeGreaterThan(0);
    expect(await card(p.key)).toMatchObject({ kinds: { missing_title: 1 } });
    expect((await api.catalogBoard()).indexBuilt).toBe(true);
  });

  it("drops a deleted channel's gaps once the index is rebuilt", async () => {
    const ch = await api.putChannel(
      { code: 'stall', name: 'Stall', currency: 'USD', locales: ['en', 'nl'], defaultLocale: 'en' },
      by,
    );
    expect(ch.ok).toBe(true);
    const p = product({ channels: { web: { visible: true }, stall: { visible: true } } });
    await api.putProducts([p], { by });
    expect(await card(p.key)).toMatchObject({ kinds: { missing_title: 1 } });
    expect((await api.deleteChannel('stall', by)).ok).toBe(true);
    // deleteChannel starts the same rebuild in the background; run it here to wait for it.
    await api.rebuildGaps(by);
    expect(await card(p.key)).toBeUndefined();
  });

  it("rebuilds from each shard's alarm after a channel change, and says it isn't built until then", async () => {
    const p = product({ channels: { web: { visible: true }, booth: { visible: true } } });
    await api.putProducts([p], { by });
    const ch = await api.putChannel(
      { code: 'booth', name: 'Booth', currency: 'USD', locales: ['en', 'it'], defaultLocale: 'en' },
      by,
    );
    expect(ch.ok).toBe(true);
    expect((await api.catalogBoard()).indexBuilt).toBe(false);
    expect(await card(p.key)).toBeUndefined();
    // GAP_REBUILD_DELAY_MS holds the rebuild back in tests: make it due, then run the alarms.
    for (let n = 0; n < PRODUCT_SHARDS; n++) {
      const stub = env.SHARD.getByName(`shard-${n}`);
      await runInDurableObject(stub, (_, state) => {
        state.storage.sql.exec('UPDATE gap_rebuild SET due = 0');
      });
      await runDurableObjectAlarm(stub);
    }
    expect((await api.catalogBoard()).indexBuilt).toBe(true);
    expect(await card(p.key)).toMatchObject({ kinds: { missing_title: 1 } });
  });

  it('backfills a shard that held products before the index, once, from its own alarm', async () => {
    const p = product({ title: { en: 'Old tee' } });
    await api.putProducts([p], { by });
    const stub = env.SHARD.getByName(`shard-${productShard(p.key)}`);
    type Backfill = { backfillGaps(): Promise<void> };
    // As the shard was before the index: products, but no gaps, board rows or `gaps_built`.
    await runInDurableObject(stub, async (shard, state) => {
      state.storage.sql.exec(`DELETE FROM settings WHERE k = 'gaps_built'`);
      state.storage.sql.exec('DELETE FROM gap_rebuild');
      state.storage.sql.exec('DELETE FROM gaps');
      state.storage.sql.exec('DELETE FROM board');
      // What the shard runs as it wakes on a Worker with the index.
      await (shard as unknown as Backfill).backfillGaps();
    });
    expect(await card(p.key)).toBeUndefined();
    expect((await api.catalogBoard()).indexBuilt).toBe(false);
    // Queued once: waking again changes nothing.
    const job = () =>
      runInDurableObject(stub, async (shard, state) => {
        await (shard as unknown as Backfill).backfillGaps();
        return state.storage.sql.exec('SELECT requested FROM gap_rebuild').toArray();
      });
    const queued = await job();
    expect(queued).toHaveLength(1);
    expect(await job()).toEqual(queued);
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).not.toBeNull();
    // GAP_REBUILD_DELAY_MS holds it back in tests: make it due, then run the alarm.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE gap_rebuild SET due = 0');
    });
    await runDurableObjectAlarm(stub);
    expect(await card(p.key)).toMatchObject({ kinds: { missing_title: 1 } });
    expect((await api.catalogBoard()).indexBuilt).toBe(true);
  });

  it("doesn't backfill a shard whose index is built, or one that doesn't know its number", async () => {
    const stub = env.SHARD.getByName('shard-backfill-unnumbered');
    const rebuilds = await runInDurableObject(stub, async (shard, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM settings WHERE k = 'gaps_built'`);
      await (shard as unknown as { backfillGaps(): Promise<void> }).backfillGaps();
      const unnumbered = sql.exec('SELECT * FROM gap_rebuild').toArray().length;
      sql.exec(`INSERT OR REPLACE INTO settings VALUES ('shard', 3), ('gaps_built', 1)`);
      await (shard as unknown as { backfillGaps(): Promise<void> }).backfillGaps();
      return [unnumbered, sql.exec('SELECT * FROM gap_rebuild').toArray().length];
    });
    expect(rebuilds).toEqual([0, 0]);
  });

  it('counts each product in Gaps once by group, and names the locales a card lacks text in', async () => {
    const before = (await api.catalogBoard()).gapGroups;
    const p = product({ description: { en: 'A cotton tee.' } });
    await api.putProducts([p], { by });
    const after = (await api.catalogBoard()).gapGroups;
    expect(after.missing).toBe(before.missing + 1);
    expect(after.conflict).toBe(before.conflict);
    expect(await card(p.key)).toMatchObject({ locales: ['fr'] });
  });

  it('refuses a column that does not exist', async () => {
    // Settled with then: expect().rejects would read properties off the RPC promise, and each
    // read pipelines another call that rejects unhandled.
    const err = await api.listBoard({ column: 'later' as 'gaps' }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('no column later');
  });
});
