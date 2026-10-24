import { env, exports } from 'cloudflare:workers';
import { DOC_FORMAT, paths } from '@orderloop/core/product/paths';
import { beforeAll, describe, expect, it } from 'vitest';

const get = (path: string) =>
  (exports as unknown as { default: Fetcher }).default.fetch(`https://catalog.example${path}`);

type Page = { total: number; next: number | null; products: { key: string }[] };
const page = async (path: string) => (await (await get(path)).json()) as Page;

beforeAll(async () => {
  for (const [uid, key] of [
    [7, 'tee'],
    [70, 'tee-long'],
    [71, 'tee-v'],
    [90, 'cap'],
  ] as const) {
    await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', uid), JSON.stringify({ key }));
    await env.CARDS.put(paths.uid(DOC_FORMAT, key), String(uid));
  }
  // CAP-1 is the cap's SKU.
  await env.PUBLISHED.put(
    paths.alias(DOC_FORMAT, 'web', 'sku:CAP-1'),
    JSON.stringify({ key: 'cap' }),
  );
});

describe('search', () => {
  it('returns cards in match order and pages them', async () => {
    const first = await page('/v1/web/en/search?q=%20TEE%20&limit=2');
    expect(first).toEqual({ total: 3, next: 2, products: [{ key: 'tee' }, { key: 'tee-long' }] });
    const rest = await page('/v1/web/en/search?q=tee&limit=2&cursor=2');
    expect(rest).toEqual({ total: 3, next: null, products: [{ key: 'tee-v' }] });
  });

  it('puts the product with that exact SKU first', async () => {
    expect(await page('/v1/web/en/search?q=cap-1')).toEqual({
      total: 1,
      next: null,
      products: [{ key: 'cap' }],
    });
  });

  it('refuses a query without a word, and paging past the depth', async () => {
    expect((await get('/v1/web/en/search?q=%20%21%20')).status).toBe(400);
    expect((await get('/v1/web/en/search')).status).toBe(400);
    expect((await get('/v1/web/en/search?q=tee&cursor=1000')).status).toBe(400);
  });

  it('caches equivalent queries under one URL', async () => {
    const { canonical, parse } = await import('../src/routes');
    const c = (q: string) => {
      const p = parse(new URL(`https://x/v1/web/en/search?${q}`));
      if (!p.ok) throw new Error(p.error);
      return canonical(p.route);
    };
    expect(c('q=Blue%20%20Tee&limit=24&utm=1')).toBe(c('q=blue+tee'));
    expect(c('q=blue+tee')).toBe('https://catalog.internal/v1/web/en/search?q=blue+tee');
  });
});
