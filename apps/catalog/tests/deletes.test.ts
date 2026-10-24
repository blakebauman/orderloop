import { env, exports } from 'cloudflare:workers';
import { DOC_FORMAT, paths } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SearchApi } from '../src/search';
import { alias, api, by, doc, product, settle, setup } from './helpers';

beforeAll(setup);

const search = (exports as unknown as { SearchApi: Service<SearchApi> }).SearchApi;

describe('deleting types', () => {
  it('refuses a type products use, and removes every version of an unused one', async () => {
    expect((await api.putProducts([product()], { by }))[0]?.status).toBe('created');
    const used = await api.deleteType('apparel', by);
    expect(used).toMatchObject({
      ok: false,
      issues: [expect.stringMatching(/^\d+ products use apparel/)],
    });

    const spare = { code: 'spare', version: 1, attributes: [{ code: 'x', kind: 'text' as const }] };
    expect((await api.putType(spare, by)).ok).toBe(true);
    expect(
      (
        await api.putType(
          {
            ...spare,
            version: 2,
            attributes: [...spare.attributes, { code: 'y', kind: 'text' as const }],
          },
          by,
        )
      ).ok,
    ).toBe(true);
    expect(await api.deleteType('spare', by)).toEqual({ ok: true, code: 'spare', versions: 2 });
    expect((await api.listTypes()).some((t) => t.code === 'spare')).toBe(false);
    expect(await api.deleteType('spare', by)).toEqual({
      ok: false,
      issues: ['spare: unknown type'],
      notFound: true,
    });
  });
});

describe('deleting categories', () => {
  it('refuses a category with children or products, then deletes leaves and their parent together', async () => {
    const r = await api.putCategories(
      [
        { code: 'del-root', name: { en: 'Root' } },
        { code: 'del-leaf', parent: 'del-root', name: { en: 'Leaf' } },
        { code: 'del-busy', name: { en: 'Busy' } },
      ],
      by,
    );
    expect(r.ok).toBe(true);
    expect(await api.deleteCategories(['del-root'], by)).toEqual({
      ok: false,
      issues: ['del-root: still the parent of del-leaf'],
    });
    await api.putProducts([product({ categories: ['del-busy'] })], { by });
    expect(await api.deleteCategories(['del-busy'], by)).toEqual({
      ok: false,
      issues: ['del-busy: 1 products are filed in it'],
    });
    const gone = await api.deleteCategories(['del-leaf', 'del-root'], by);
    expect(gone.ok && [...gone.deleted].sort()).toEqual(['del-leaf', 'del-root']);
    const tree = await env.PUBLISHED.get(paths.categories(DOC_FORMAT, 'web', 'en'));
    if (!tree) throw new Error('no category tree');
    const { categories } = (await tree.json()) as { categories: { code: string }[] };
    const codes = categories.map((c) => c.code);
    expect(codes).not.toContain('del-root');
    expect(codes).toContain('del-busy');
  });
});

describe('deleting channels', () => {
  it('takes down everything published in the channel, and leaves other channels alone', async () => {
    const outlet = {
      code: 'outlet',
      name: 'Outlet',
      currency: 'USD',
      locales: ['en'],
      defaultLocale: 'en',
    };
    expect((await api.putChannel(outlet, by)).ok).toBe(true);
    const word = `zz${Date.now().toString(36)}`;
    const p = product({
      title: { en: `Outlet ${word}` },
      channels: {
        web: { visible: true, price: { amount: 100, currency: 'USD' } },
        outlet: { visible: true, price: { amount: 50, currency: 'USD' } },
      },
    });
    await api.putProducts([p], { by });
    await settle();
    const docIn = (ch: string) => env.PUBLISHED.head(paths.doc(DOC_FORMAT, ch, 'en', p.key));
    expect(await docIn('outlet')).not.toBeNull();
    // Search has it in the outlet channel.
    let found = 0;
    for (let i = 0; i < 100 && !found; i++) {
      found = (await search.search('outlet', 'en', word, 10, 0)).total;
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBe(1);

    const r = await api.deleteChannel('outlet', by);
    expect(r).toMatchObject({ ok: true, code: 'outlet' });
    if (r.ok) expect(r.unpublished).toBeGreaterThanOrEqual(1);
    expect((await api.listChannels()).some((c) => c.code === 'outlet')).toBe(false);
    expect(await docIn('outlet')).toBeNull();
    expect(await env.PUBLISHED.get(paths.alias(DOC_FORMAT, 'outlet', `sku:${p.key}-S`))).toBeNull();
    expect(await env.PUBLISHED.head(paths.categories(DOC_FORMAT, 'outlet', 'en'))).toBeNull();
    for (let i = 0; i < 100 && found; i++) {
      found = (await search.search('outlet', 'en', word, 10, 0)).total;
      if (found) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBe(0);
    // The product is still published in web, and still holds its outlet listing data.
    expect(await doc(p.key)).toMatchObject({ key: p.key });
    expect(await alias(`sku:${p.key}-S`)).toEqual({ key: p.key });
    expect((await api.getProduct(p.key))?.channels.outlet).toBeTruthy();
    // Deleting it again finds nothing left to take down.
    expect(await api.deleteChannel('outlet', by)).toEqual({
      ok: false,
      issues: ['outlet: unknown channel'],
      notFound: true,
    });
  });
});
