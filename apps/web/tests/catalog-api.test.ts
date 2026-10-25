import type { Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = {
  getProduct: vi.fn(),
  putProducts: vi.fn(),
  deleteProducts: vi.fn(),
  resolveAlias: vi.fn(),
  putType: vi.fn(),
  listTypes: vi.fn(),
  putChannel: vi.fn(),
  listChannels: vi.fn(),
  putCategories: vi.fn(),
  listCategories: vi.fn(),
  startFeed: vi.fn(),
  feedStatus: vi.fn(),
  listFeeds: vi.fn(),
  cancelFeed: vi.fn(),
  reindex: vi.fn(),
  deleteType: vi.fn(),
  deleteChannel: vi.fn(),
  deleteCategories: vi.fn(),
};
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({
  catalog: () => catalog,
  engine: () => ({}),
  db: () => ({}),
  afterResponse: () => {},
}));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({ currencies: async () => [], listOrders: async () => [] }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({
  actor: () => 'ops@example.com',
  forbidden: () => 'Forbidden',
}));

const { handleApi } = await import('~/lib/api.server');

const viewer: Principal = { kind: 'token', id: 'tok_v', name: 'reader', role: 'viewer' };
const operator: Principal = { ...viewer, id: 'tok_o', role: 'operator', email: 'ops@example.com' };
const admin: Principal = { ...operator, id: 'tok_a', role: 'admin' };

const call = (
  method: string,
  path: string,
  as: Principal,
  body?: BodyInit,
  type = 'application/json',
) =>
  handleApi(
    new Request(`https://app.test/api/v1/catalog/${path}`, {
      method,
      headers: { 'content-type': type },
      body,
    }),
    as,
  );

const product = {
  key: 'tee',
  type: 'apparel',
  title: { en: 'Tee' },
  variants: [{ sku: 'TEE-S' }],
};

beforeEach(() => {
  for (const fn of Object.values(catalog)) fn.mockReset();
  audit.mockReset();
});

describe('catalog products over REST', () => {
  it('writes products as the operator, audited with the counts', async () => {
    catalog.putProducts.mockResolvedValue([{ key: 'tee', status: 'created', version: 1 }]);
    const r = await call(
      'POST',
      'products',
      operator,
      JSON.stringify({ products: [product], urgent: true }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ results: [{ key: 'tee', status: 'created', version: 1 }] });
    expect(catalog.putProducts).toHaveBeenCalledWith([expect.objectContaining({ key: 'tee' })], {
      by: 'ops@example.com',
      urgent: true,
    });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'catalog.products_written', {
      actor: operator,
      detail: { created: 1, updated: 0, unchanged: 0, rejected: 0, urgent: true, via: 'api' },
    });
  });

  it('refuses a viewer writing, a malformed body and more than 500 products', async () => {
    expect(
      (await call('POST', 'products', viewer, JSON.stringify({ products: [product] }))).status,
    ).toBe(403);
    expect(
      (await call('POST', 'products', operator, JSON.stringify({ products: [{ key: 'x' }] })))
        .status,
    ).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => ({ ...product, key: `p${i}` }));
    expect(
      (await call('POST', 'products', operator, JSON.stringify({ products: many }))).status,
    ).toBe(400);
    expect(catalog.putProducts).not.toHaveBeenCalled();
  });

  it('reads a product and resolves an alias as a viewer, 404 when unknown', async () => {
    catalog.getProduct
      .mockResolvedValueOnce({ key: 'tee', version: 3 })
      .mockResolvedValueOnce(null);
    expect(await (await call('GET', 'products/tee', viewer)).json()).toEqual({
      product: { key: 'tee', version: 3 },
    });
    expect((await call('GET', 'products/nope', viewer)).status).toBe(404);
    catalog.resolveAlias.mockResolvedValue('tee');
    expect(await (await call('GET', 'aliases/sku%3ATEE-S', viewer)).json()).toEqual({ key: 'tee' });
  });

  it('deletes products', async () => {
    catalog.deleteProducts.mockResolvedValue([{ key: 'tee', status: 'deleted', version: 2 }]);
    const r = await call('POST', 'products/delete', operator, JSON.stringify({ keys: ['tee'] }));
    expect(r.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      'catalog.products_deleted',
      expect.anything(),
    );
  });
});

describe('catalog setup over REST', () => {
  it('saves a type, answering 409 with the reasons when a version would break', async () => {
    const type = { code: 'apparel', version: 1, attributes: [] };
    catalog.putType.mockResolvedValueOnce({ ok: true, type });
    expect((await call('POST', 'types', operator, JSON.stringify(type))).status).toBe(201);
    catalog.putType.mockResolvedValueOnce({
      ok: false,
      issues: ['material removed (deprecate it instead)'],
    });
    const refused = await call('POST', 'types', operator, JSON.stringify({ ...type, version: 2 }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      issues: ['material removed (deprecate it instead)'],
    });
  });

  it('saves channels and categories, and lists them for a viewer', async () => {
    const channel = {
      code: 'web',
      name: 'Web',
      currency: 'USD',
      locales: ['en'],
      defaultLocale: 'en',
    };
    catalog.putChannel.mockResolvedValue({ ok: true, channel });
    expect((await call('POST', 'channels', operator, JSON.stringify(channel))).status).toBe(200);
    catalog.putCategories.mockResolvedValue({ ok: false, issues: ['tees: unknown parent tops'] });
    const r = await call(
      'POST',
      'categories',
      operator,
      JSON.stringify({ categories: [{ code: 'tees', parent: 'tops', name: { en: 'Tees' } }] }),
    );
    expect(r.status).toBe(400);
    catalog.listChannels.mockResolvedValue([channel]);
    expect(await (await call('GET', 'channels', viewer)).json()).toEqual({ channels: [channel] });
  });

  it('streams a feed file to the catalog and answers 202 with its status', async () => {
    catalog.startFeed.mockImplementation(async (stream: ReadableStream, meta: unknown) => ({
      id: 'feed_1',
      state: 'queued',
      received: await new Response(stream).text(),
      meta,
    }));
    const r = await call(
      'POST',
      'feeds?format=csv&name=supplier.csv',
      operator,
      'key,sku\nx,X1',
      'text/csv',
    );
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({
      feed: {
        id: 'feed_1',
        state: 'queued',
        received: 'key,sku\nx,X1',
        meta: { name: 'supplier.csv', format: 'csv', by: 'ops@example.com' },
      },
    });
    expect((await call('POST', 'feeds?format=xml', operator, 'x')).status).toBe(400);
  });

  it('answers 408 when the catalog gave up on a feed that stopped arriving', async () => {
    catalog.startFeed.mockRejectedValue(new Error('upload stalled: no bytes for 30 s'));
    const r = await call('POST', 'feeds?format=csv', operator, 'key,sku\nx,X1', 'text/csv');
    expect(r.status).toBe(408);
    expect(((await r.json()) as { error: string }).error).toContain('Send it again');
    catalog.startFeed.mockRejectedValue(new Error('something else'));
    expect((await call('POST', 'feeds?format=csv', operator, 'key,sku', 'text/csv')).status).toBe(
      500,
    );
  });

  it('cancels a feed for an operator, with 404 when unknown and 409 once finished', async () => {
    expect((await call('POST', 'feeds/feed_1/cancel', viewer)).status).toBe(403);
    catalog.cancelFeed.mockResolvedValueOnce({ id: 'feed_1', state: 'cancelled' });
    const r = await call('POST', 'feeds/feed_1/cancel', operator);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ feed: { id: 'feed_1', state: 'cancelled' } });
    expect(catalog.cancelFeed).toHaveBeenCalledWith('feed_1', 'ops@example.com');
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      'catalog.feed_cancelled',
      expect.objectContaining({ target: 'feed_1' }),
    );
    catalog.cancelFeed.mockResolvedValueOnce(null);
    expect((await call('POST', 'feeds/nope/cancel', operator)).status).toBe(404);
    catalog.cancelFeed.mockResolvedValueOnce({ id: 'feed_2', state: 'done' });
    expect((await call('POST', 'feeds/feed_2/cancel', operator)).status).toBe(409);
  });

  it('reindexes only for an admin', async () => {
    expect((await call('POST', 'reindex', operator)).status).toBe(403);
    catalog.reindex.mockResolvedValue({ queued: 12 });
    const r = await call('POST', 'reindex', admin);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ queued: 12 });
  });

  it('deletes types, channels (admin only) and categories, with 404 and 409 when refused', async () => {
    catalog.deleteType.mockResolvedValueOnce({
      ok: false,
      issues: ['3 products use apparel: delete or move them first'],
    });
    expect((await call('DELETE', 'types/apparel', operator)).status).toBe(409);
    catalog.deleteType.mockResolvedValueOnce({
      ok: false,
      issues: ['nope: unknown type'],
      notFound: true,
    });
    expect((await call('DELETE', 'types/nope', operator)).status).toBe(404);
    catalog.deleteType.mockResolvedValueOnce({ ok: true, code: 'spare', versions: 2 });
    expect(await (await call('DELETE', 'types/spare', operator)).json()).toEqual({
      ok: true,
      code: 'spare',
      versions: 2,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      'catalog.type_deleted',
      expect.objectContaining({ target: 'spare' }),
    );

    expect((await call('DELETE', 'channels/outlet', operator)).status).toBe(403);
    catalog.deleteChannel.mockResolvedValueOnce({ ok: true, code: 'outlet', unpublished: 12 });
    expect(await (await call('DELETE', 'channels/outlet', admin)).json()).toEqual({
      ok: true,
      code: 'outlet',
      unpublished: 12,
    });

    catalog.deleteCategories.mockResolvedValueOnce({
      ok: false,
      issues: ['tops: still the parent of tees'],
    });
    expect(
      (await call('POST', 'categories/delete', operator, JSON.stringify({ codes: ['tops'] })))
        .status,
    ).toBe(409);
    catalog.deleteCategories.mockResolvedValueOnce({ ok: true, deleted: ['tees', 'tops'] });
    expect(
      (
        await call(
          'POST',
          'categories/delete',
          operator,
          JSON.stringify({ codes: ['tees', 'tops'] }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('POST', 'categories/delete', operator, JSON.stringify({ codes: [] }))).status,
    ).toBe(400);
  });

  it('answers 404 for anything else', async () => {
    expect((await call('GET', 'widgets', admin)).status).toBe(404);
    expect((await call('DELETE', 'products/tee', admin)).status).toBe(404);
    expect((await call('DELETE', 'categories/tees', admin)).status).toBe(404);
  });
});
