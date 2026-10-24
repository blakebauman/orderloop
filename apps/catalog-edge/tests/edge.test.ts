import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { DOC_FORMAT, paths } from '@orderloop/core/product/paths';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src';
import { FRESH, MISSING } from '../src/delivery';

const get = (path: string, init?: RequestInit) =>
  (exports as unknown as { default: Fetcher }).default.fetch(
    `https://catalog.example${path}`,
    init,
  );

const doc = (key: string, title: string) => JSON.stringify({ key, title, version: 1 });
const card = (key: string, title: string) => JSON.stringify({ key, title });

beforeAll(async () => {
  // What the catalog's publisher writes for two products and a category tree.
  const json = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };
  await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'en', 'tee'), doc('tee', 'Tee'), json);
  await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'fr', 'tee'), doc('tee', 'T-shirt'), json);
  await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'en', 'hat'), doc('hat', 'Hat'), json);
  await env.PUBLISHED.put(
    paths.alias(DOC_FORMAT, 'web', 'sku:TEE-S'),
    JSON.stringify({ key: 'tee' }),
  );
  await env.PUBLISHED.put(
    paths.alias(DOC_FORMAT, 'web', 'slug:fr:t-shirt'),
    JSON.stringify({ key: 'tee' }),
  );
  await env.PUBLISHED.put(paths.categories(DOC_FORMAT, 'web', 'en'), '{"categories":[]}', json);
  await env.CARDS.put(paths.uid(DOC_FORMAT, 'tee'), '7');
  await env.CARDS.put(paths.uid(DOC_FORMAT, 'hat'), '70');
  await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 7), card('tee', 'Tee'));
  await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 70), card('hat', 'Hat'));
});

describe('documents', () => {
  it('serves a product document with its ETag, freshness and tags', async () => {
    const r = await get('/v1/web/fr/products/tee');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ key: 'tee', title: 'T-shirt', version: 1 });
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe(FRESH);
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 304 when the ETag still matches, which is how the cache revalidates', async () => {
    const etag = (await get('/v1/web/en/products/tee')).headers.get('etag') ?? '';
    const r = await get('/v1/web/en/products/tee', { headers: { 'if-none-match': etag } });
    expect(r.status).toBe(304);
    expect(r.headers.get('etag')).toBe(etag);
    expect(await r.text()).toBe('');
    expect(
      (await get('/v1/web/en/products/tee', { headers: { 'if-none-match': '"other"' } })).status,
    ).toBe(200);
  });

  it('finds a product by SKU and by slug', async () => {
    expect(await (await get('/v1/web/en/skus/TEE-S')).json()).toMatchObject({ title: 'Tee' });
    expect(await (await get('/v1/web/fr/slugs/t-shirt')).json()).toMatchObject({
      title: 'T-shirt',
    });
    const none = await get('/v1/web/en/skus/NOPE');
    expect(none.status).toBe(404);
    expect(none.headers.get('cache-control')).toBe(MISSING);
  });

  it('remembers a missing product only briefly', async () => {
    const r = await get('/v1/web/en/products/nope');
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe(MISSING);
  });

  it('serves the category tree', async () => {
    const r = await get('/v1/web/en/categories');
    expect(await r.json()).toEqual({ categories: [] });
    expect(r.headers.get('etag')).toBeTruthy();
  });

  it('answers HEAD without a body', async () => {
    const r = await get('/v1/web/en/products/tee', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBeTruthy();
    expect(await r.text()).toBe('');
  });
});

describe('batches', () => {
  it('returns cards in the order asked, null for unknown keys, duplicates once', async () => {
    const r = await get('/v1/web/en/products?keys=hat,nope,tee,hat');
    expect(await r.json()).toEqual({
      products: [{ key: 'hat', title: 'Hat' }, null, { key: 'tee', title: 'Tee' }],
    });
    expect(r.headers.get('cache-control')).toBe(FRESH);
  });

  it('refuses a batch without keys, with too many, or with a bad one', async () => {
    expect((await get('/v1/web/en/products')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `k${i}`).join(',');
    expect(await (await get(`/v1/web/en/products?keys=${many}`)).json()).toEqual({
      error: 'at most 100 keys',
    });
    expect((await get('/v1/web/en/products?keys=ok,bad%20key')).status).toBe(400);
  });
});

describe('the gateway', () => {
  it('refuses writes and answers preflights', async () => {
    expect((await get('/v1/web/en/products/tee', { method: 'POST' })).status).toBe(405);
    const pre = await get('/v1/web/en/products/tee', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toBe('if-none-match');
  });

  it('refuses malformed routes before they reach the cache', async () => {
    expect((await get('/v2/web/en/products/tee')).status).toBe(404);
    expect((await get('/v1/we%20b/en/products/tee')).status).toBe(400);
    expect((await get('/v1/web/EN_us/products/tee')).status).toBe(400);
    expect((await get('/v1/web/en/slugs/Not-A-Slug')).status).toBe(400);
    expect((await get('/v1/web/en/widgets')).status).toBe(404);
    expect(await (await get('/health')).json()).toEqual({ ok: true });
  });
});

describe('purging', () => {
  it('acknowledges a purge batch (no Workers Caching locally, so nothing to purge)', async () => {
    const batch = createMessageBatch('orderloop-catalog-purge', [
      { id: 'a', timestamp: new Date(), attempts: 1, body: { tags: ['p:tee'] } },
      { id: 'b', timestamp: new Date(), attempts: 1, body: { tags: ['p:tee', 'p:hat'] } },
    ]);
    const ctx = Object.assign(createExecutionContext(), { exports });
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.ackAll).toBe(true);
    expect(result.retryBatch.retry).toBe(false);
  });
});
