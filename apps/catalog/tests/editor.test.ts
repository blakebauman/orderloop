import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { BoardCard, BoardColumn, ProductInput, StageEdit } from '@orderloop/core/product';
import { productShard } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, by, doc, product, settle, setup } from './helpers';

beforeAll(setup);

const ed = 'editor@orderloop';
const descFr = { field: 'description' as const, locale: 'fr' };
const titleFr = { field: 'title' as const, locale: 'fr' };

/** A product's card in a column, if it is there. */
async function card(column: BoardColumn, key: string): Promise<BoardCard | undefined> {
  let cursor: string | undefined;
  do {
    const page = await api.listBoard({ column, cursor, limit: 100 });
    const found = page.items.find((c) => c.key === key);
    if (found) return found;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return undefined;
}

let requests = 0;
const publish = (keys: string[], requestId = `req-${++requests}-${Date.now()}`) =>
  api.publishStaged(keys, { by: ed, requestId });

const set = (key: string, ref: StageEdit['ref'], value: string | null): StageEdit => ({
  key,
  ref,
  op: 'set',
  value,
});

/** A product with an English description only: a gap in French. */
async function gappy(over: Partial<ProductInput> = {}) {
  const p = product({ description: { en: 'A cotton tee.' }, ...over });
  expect((await api.putProducts([p], { by }))[0]?.status).toBe('created');
  return p;
}

describe('staging and publishing', () => {
  it('stages an edit without changing the product, then publishes it and moves the card', async () => {
    const p = await gappy();
    expect(await card('gaps', p.key)).toBeDefined();

    expect(await api.stageEdits([set(p.key, descFr, 'Un t-shirt en coton.')], ed)).toEqual([
      { key: p.key, ref: descFr, ok: true },
    ]);
    // Staged only: nothing live has changed, and the gap stands until it is published; the card
    // moves to Staged, still counting it.
    expect((await api.getProduct(p.key))?.description).toEqual({ en: 'A cotton tee.' });
    expect(await card('staged', p.key)).toMatchObject({
      staged: 1,
      failure: null,
      kinds: { missing_description: 1 },
    });
    expect(await card('gaps', p.key)).toBeUndefined();

    const [r] = await publish([p.key]);
    expect(r).toMatchObject({ key: p.key, status: 'published', version: 2 });
    expect((await api.getProduct(p.key))?.description).toEqual({
      en: 'A cotton tee.',
      fr: 'Un t-shirt en coton.',
    });
    expect(await card('gaps', p.key)).toBeUndefined();
    expect(await card('published', p.key)).toMatchObject({ staged: 0 });

    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.feed.description).toEqual({ en: 'A cotton tee.' });
    expect(sheet?.staged).toEqual([]);
    expect(sheet?.overrides).toEqual([
      expect.objectContaining({
        ref: descFr,
        value: 'Un t-shirt en coton.',
        base: null,
        feed: null,
        conflict: false,
        source: 'person',
        by: ed,
      }),
    ]);
    expect(sheet?.revisions).toEqual([
      expect.objectContaining({
        ref: descFr,
        op: 'set',
        value: 'Un t-shirt en coton.',
        previous: null,
        by: ed,
      }),
    ]);

    // It publishes like any write: through the outbox to the documents.
    await settle();
    expect((await doc(p.key, 'fr'))?.description).toBe('Un t-shirt en coton.');
  });

  it('puts a product with staged edits and no gaps on Staged', async () => {
    const p = product();
    await api.putProducts([p], { by });
    expect(await card('gaps', p.key)).toBeUndefined();
    await api.stageEdits([set(p.key, titleFr, 'Le t-shirt')], ed);
    expect(await card('staged', p.key)).toMatchObject({ staged: 1 });
    expect((await api.catalogBoard()).columns.staged).toBeGreaterThan(0);
  });

  it('replaces an earlier staged edit to the same field, and discards one or all', async () => {
    const p = await gappy();
    await api.stageEdits([set(p.key, descFr, 'Premier')], ed);
    await api.stageEdits(
      [set(p.key, descFr, 'Second'), set(p.key, { field: 'status' }, 'draft')],
      ed,
    );
    const staged = (await api.getProductSheet(p.key))?.staged ?? [];
    expect(staged.map((s) => [s.ref.field, s.value])).toEqual([
      ['description', 'Second'],
      ['status', 'draft'],
    ]);
    expect(await api.discardStaged([{ key: p.key, ref: { field: 'status' } }], ed)).toEqual({
      discarded: 1,
    });
    expect(await api.discardStaged([{ key: p.key }], ed)).toEqual({ discarded: 1 });
    expect((await api.getProductSheet(p.key))?.staged).toEqual([]);
    expect(await card('gaps', p.key)).toMatchObject({ staged: 0 });
  });

  it('refuses edits the catalog would not store, and says why per edit', async () => {
    const p = await gappy();
    const r = await api.stageEdits(
      [
        set('no-such-product', descFr, 'x'),
        set(p.key, { field: 'price' as 'title', locale: 'fr' }, '9'),
        set(p.key, { field: 'slug', locale: 'fr' }, 'Not A Slug'),
        set(p.key, { field: 'attribute', code: 'material', locale: 'fr' }, 'Coton'),
        { key: p.key, ref: descFr, op: 'clear' },
      ],
      ed,
    );
    expect(r.map((x) => (x.ok ? 'ok' : x.issues[0]))).toEqual([
      'no such product',
      'not an editable field',
      'lowercase words joined by "-"',
      "material isn't product text with a value per locale",
      'no edit to clear: it already shows the feed value',
    ]);
    expect((await api.getProductSheet(p.key))?.staged).toEqual([]);
  });

  it('answers a repeated publish request the same, publishing once', async () => {
    const p = await gappy();
    await api.stageEdits([set(p.key, descFr, 'Coton.')], ed);
    const id = `once-${p.key}`;
    const first = await publish([p.key], id);
    expect(first[0]).toMatchObject({ status: 'published', version: 2 });
    expect(await publish([p.key], id)).toEqual(first);
    expect((await api.getProduct(p.key))?.version).toBe(2);
    // A new request with nothing staged has nothing to do.
    expect((await publish([p.key]))[0]?.status).toBe('unchanged');
  });

  it('refuses to publish a value changed since it was staged, and keeps the edits staged', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await api.stageEdits(
      [set(p.key, titleFr, 'Le t-shirt'), set(p.key, { field: 'status' }, 'draft')],
      ed,
    );
    // The feed changes the French title under the staged edit.
    await api.putProducts([{ ...p, title: { en: p.title.en ?? '', fr: 'Nouveau' } }], { by });
    const [r] = await publish([p.key]);
    expect(r).toMatchObject({
      status: 'failed',
      issues: ['title (fr) changed since it was staged'],
    });
    const product_ = await api.getProduct(p.key);
    expect(product_?.title.fr).toBe('Nouveau');
    expect(product_?.status).toBe('active');
    expect(await card('staged', p.key)).toMatchObject({
      staged: 2,
      failure: 'title (fr) changed since it was staged',
    });
    // Staged again against what is there now, it publishes.
    await api.stageEdits([set(p.key, titleFr, 'Le t-shirt')], ed);
    expect((await publish([p.key]))[0]?.status).toBe('published');
    expect((await api.getProduct(p.key))?.title.fr).toBe('Le t-shirt');
  });

  it('claims a slug it publishes, and refuses one another product holds', async () => {
    const a = product();
    const b = product();
    await api.putProducts([a, b], { by });
    const slug = `editor-slug-${a.key}`;
    await api.stageEdits([set(a.key, { field: 'slug', locale: 'fr' }, slug)], ed);
    expect((await publish([a.key]))[0]?.status).toBe('published');
    expect(await api.resolveAlias(`slug:fr:${slug}`)).toBe(a.key);

    await api.stageEdits([set(b.key, { field: 'slug', locale: 'fr' }, slug)], ed);
    const [r] = await publish([b.key]);
    expect(r?.status).toBe('failed');
    expect(r?.issues?.[0]).toContain(`already used by ${a.key}`);
    expect(await api.resolveAlias(`slug:fr:${slug}`)).toBe(a.key);
    expect((await api.getProduct(b.key))?.slug?.fr).toBeUndefined();
  });

  it('releases the slug a published edit replaces', async () => {
    const p = product();
    await api.putProducts([p], { by });
    const first = `first-${p.key}`;
    const second = `second-${p.key}`;
    await api.stageEdits([set(p.key, { field: 'slug', locale: 'fr' }, first)], ed);
    await publish([p.key]);
    await api.stageEdits([set(p.key, { field: 'slug', locale: 'fr' }, second)], ed);
    expect((await publish([p.key]))[0]?.status).toBe('published');
    expect(await api.resolveAlias(`slug:fr:${second}`)).toBe(p.key);
    expect(await api.resolveAlias(`slug:fr:${first}`)).toBeNull();
  });

  it('refuses a request id reused for other products, leaving their edits staged', async () => {
    const a = await gappy();
    const b = await gappy();
    await api.stageEdits([set(a.key, descFr, 'A.'), set(b.key, descFr, 'B.')], ed);
    const id = `reused-${a.key}`;
    expect((await publish([a.key], id))[0]?.status).toBe('published');
    const [r] = await publish([b.key], id);
    // Only when both land on one shard is the id seen again; either way B isn't lost.
    if (productShard(a.key) === productShard(b.key)) expect(r).toMatchObject({ status: 'failed' });
    else expect(r?.status).toBe('published');
    if (r?.status === 'failed') expect((await api.getProductSheet(b.key))?.staged).toHaveLength(1);
  });

  it('publishes each product on its own: one refused leaves the others published', async () => {
    const ok = await gappy();
    const stale = product();
    await api.putProducts([stale], { by });
    await api.stageEdits([set(ok.key, descFr, 'Coton.'), set(stale.key, titleFr, 'Vieux')], ed);
    await api.putProducts([{ ...stale, title: { en: 'Changed', fr: 'Changé' } }], { by });
    const results = await publish([ok.key, stale.key, ok.key]);
    expect(results.map((r) => [r.key, r.status])).toEqual([
      [ok.key, 'published'],
      [stale.key, 'failed'],
    ]);
  });
});

describe('overrides over feed imports', () => {
  async function overridden() {
    const p = await gappy();
    await api.stageEdits([set(p.key, descFr, 'Mon texte.')], ed);
    expect((await publish([p.key]))[0]?.status).toBe('published');
    return p;
  }

  it('keeps an edit through the next import, and knows an unchanged row', async () => {
    const p = await overridden();
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('unchanged');
    const changed = { ...p, title: { en: 'Renamed tee', fr: 'T-shirt renommé' } };
    expect((await api.putProducts([changed], { by }))[0]?.status).toBe('updated');
    const live = await api.getProduct(p.key);
    expect(live?.title.en).toBe('Renamed tee');
    expect(live?.description).toEqual({ en: 'A cotton tee.', fr: 'Mon texte.' });
    expect((await api.getProductSheet(p.key))?.overrides[0]?.conflict).toBe(false);
    expect(await card('gaps', p.key)).toBeUndefined();
  });

  it('makes a conflict when the feed changes the value, keeping the edit live', async () => {
    const p = await overridden();
    const theirs = { ...p, description: { en: 'A cotton tee.', fr: 'Leur texte.' } };
    await api.putProducts([theirs], { by });
    expect((await api.getProduct(p.key))?.description?.fr).toBe('Mon texte.');
    expect(await card('gaps', p.key)).toMatchObject({ kinds: { conflict: 1 } });
    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.overrides[0]).toMatchObject({
      value: 'Mon texte.',
      base: null,
      feed: 'Leur texte.',
      conflict: true,
    });
    expect(sheet?.gaps).toContainEqual({
      kind: 'conflict',
      field: 'description',
      locale: 'fr',
      channel: '',
    });
    // Counted on the board too.
    expect((await api.catalogBoard()).gapsByKind.conflict?.products).toBeGreaterThan(0);
  });

  it('resolves a conflict by keeping the edit', async () => {
    const p = await overridden();
    await api.putProducts([{ ...p, description: { en: 'A cotton tee.', fr: 'Leur texte.' } }], {
      by,
    });
    await api.stageEdits([set(p.key, descFr, 'Mon texte.')], ed);
    expect((await publish([p.key]))[0]?.status).toBe('published');
    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.overrides[0]).toMatchObject({ base: 'Leur texte.', conflict: false });
    expect(sheet?.product.description?.fr).toBe('Mon texte.');
    expect(await card('gaps', p.key)).toBeUndefined();
  });

  it("resolves a conflict by taking the feed's value, dropping the override", async () => {
    const p = await overridden();
    await api.putProducts([{ ...p, description: { en: 'A cotton tee.', fr: 'Leur texte.' } }], {
      by,
    });
    await api.stageEdits([{ key: p.key, ref: descFr, op: 'clear' }], ed);
    expect((await publish([p.key]))[0]?.status).toBe('published');
    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.overrides).toEqual([]);
    expect(sheet?.product.description?.fr).toBe('Leur texte.');
    expect(sheet?.revisions[0]).toMatchObject({
      op: 'clear',
      value: 'Leur texte.',
      previous: 'Mon texte.',
    });
    expect(await card('gaps', p.key)).toBeUndefined();
    // No overrides left: the feed's row is the product again, and resending it changes nothing.
    expect(
      (
        await api.putProducts([{ ...p, description: { en: 'A cotton tee.', fr: 'Leur texte.' } }], {
          by,
        })
      )[0]?.status,
    ).toBe('unchanged');
  });

  it('puts its overrides back on a product written without them', async () => {
    const p = await overridden();
    // What a Worker from before overrides did during a rollback: the feed's row stored as live.
    await runInDurableObject(env.SHARD.getByName(`shard-${productShard(p.key)}`), (_, state) => {
      const sql = state.storage.sql;
      const row = sql
        .exec<{ hash: string; body: string }>(
          'SELECT hash, body FROM feed_rows WHERE key = ?',
          p.key,
        )
        .one();
      sql.exec('UPDATE products SET hash = ?, body = ? WHERE key = ?', row.hash, row.body, p.key);
    });
    expect((await api.getProduct(p.key))?.description?.fr).toBeUndefined();
    // The same feed row again isn't taken as unchanged: the overrides go back on.
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('updated');
    expect((await api.getProduct(p.key))?.description?.fr).toBe('Mon texte.');
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('unchanged');
  });

  it('forgets every edit, staged or live, when the product is deleted', async () => {
    const p = await overridden();
    await api.stageEdits([set(p.key, titleFr, 'Encore')], ed);
    await api.deleteProducts([p.key], { by });
    expect(await api.getProductSheet(p.key)).toBeNull();
    // Created again, it starts from the feed alone.
    await api.putProducts([p], { by });
    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.overrides).toEqual([]);
    expect(sheet?.staged).toEqual([]);
    expect(sheet?.revisions).toEqual([]);
    expect(sheet?.product.description).toEqual({ en: 'A cotton tee.' });
  });
});
