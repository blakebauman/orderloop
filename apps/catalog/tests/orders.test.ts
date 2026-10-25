import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOrders, type OrderLine } from '../src/orders';
import { api, by, product, settle, setup } from './helpers';

beforeAll(setup);

type Row = { sku: string; name: string; price: number; stock: number; catalog_at: number | null };
const row = (sku: string) =>
  env.DB.prepare('SELECT sku, name, price, stock, catalog_at FROM products WHERE sku = ?')
    .bind(sku)
    .first<Row>();

async function until(sku: string, check: (r: Row | null) => boolean) {
  let r = await row(sku);
  for (let i = 0; i < 200 && !check(r); i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = await row(sku);
  }
  return r;
}

describe("Order Loop's products", () => {
  it('keeps each variant SKU with its name and price, leaving stock alone', async () => {
    const p = product({
      title: { en: 'Field jacket' },
      variants: [
        { sku: `${Date.now()}-S`, attributes: { size: 'S' } },
        {
          sku: `${Date.now()}-M`,
          attributes: { size: 'M' },
          prices: { web: { amount: 2250, currency: 'USD' } },
        },
      ],
    });
    const [s, m] = p.variants.map((v) => v.sku) as [string, string];
    // A row Order Loop already had, with stock of its own.
    await env.DB.prepare(
      "INSERT INTO products (sku, name, price, cost, stock) VALUES (?, 'old', 1, 0.5, 7)",
    )
      .bind(s)
      .run();
    await api.putProducts([p], { by });
    await settle();
    expect(await until(s, (r) => r?.name !== 'old')).toMatchObject({
      name: 'Field jacket (S)',
      price: 19.99,
      stock: 7,
    });
    expect(await until(m, (r) => !!r)).toMatchObject({ name: 'Field jacket (M)', price: 22.5 });
  });

  const sized = (sku: string) =>
    env.DB.prepare(
      'SELECT name, weight_kg, length_cm, width_cm, height_cm FROM products WHERE sku = ?',
    )
      .bind(sku)
      .first();
  const none = { weight_kg: null, length_cm: null, width_cm: null, height_cm: null };

  it('carries a variant’s shipping weight and size, and clears them once the variant drops them', async () => {
    const duffel = {
      sku: `${Date.now()}-duffel`,
      attributes: { size: 'L' },
      weightKg: 1.2,
      dimensionsCm: { length: 60, width: 30, height: 30 },
    };
    const bare = { sku: `${Date.now()}-duffel-bare`, attributes: { size: 'S' } };
    const p = product({ title: { en: 'Duffel' }, variants: [duffel, bare] });
    await api.putProducts([p], { by });
    await settle();
    await until(duffel.sku, (r) => !!r);
    expect(await sized(duffel.sku)).toEqual({
      name: 'Duffel (L)',
      weight_kg: 1.2,
      length_cm: 60,
      width_cm: 30,
      height_cm: 30,
    });
    // One never given them has none.
    await until(bare.sku, (r) => !!r);
    expect(await sized(bare.sku)).toEqual({ name: 'Duffel (S)', ...none });

    // Removed in the catalog, they're removed here too, or `dim_weight` would bill the old size.
    const { weightKg: _w, dimensionsCm: _d, ...unsized } = duffel;
    await api.putProducts([{ ...p, title: { en: 'Soft duffel' }, variants: [unsized, bare] }], {
      by,
    });
    await settle();
    await until(duffel.sku, (r) => r?.name === 'Soft duffel (L)');
    expect(await sized(duffel.sku)).toEqual({ name: 'Soft duffel (L)', ...none });
    await until(bare.sku, (r) => r?.name === 'Soft duffel (S)');
    expect(await sized(bare.sku)).toEqual({ name: 'Soft duffel (S)', ...none });
  });

  it('clears them for a line that omits them, as the catalog before explicit nulls sent', async () => {
    const sku = `unsized-${Date.now()}`;
    const crate = { sku, name: 'Crate', price: 1 };
    const sizedCrate = { ...crate, weightKg: 4, lengthCm: 50, widthCm: 40, heightCm: 30 };
    const change = (at: number, line: OrderLine) => ({
      channel: 'web',
      key: 'k',
      at,
      entry: null,
      left: [],
      search: null,
      order: [line],
    });
    await applyOrders(env, [change(100, sizedCrate)]);
    expect(await sized(sku)).toMatchObject({ weight_kg: 4, length_cm: 50, height_cm: 30 });
    // That code left the fields out only for a variant that had none.
    await applyOrders(env, [change(200, crate as OrderLine)]);
    expect(await sized(sku)).toEqual({ name: 'Crate', ...none });
    // And an older change can't bring them back.
    await applyOrders(env, [change(150, sizedCrate)]);
    expect(await sized(sku)).toEqual({ name: 'Crate', ...none });
  });

  it('never lets an older change overwrite a newer one', async () => {
    const sku = `order-${Date.now()}`;
    const line = (name: string): OrderLine[] => [
      { sku, name, price: 1, weightKg: null, lengthCm: null, widthCm: null, heightCm: null },
    ];
    const change = (at: number, name: string) => ({
      channel: 'web',
      key: 'k',
      at,
      entry: null,
      left: [],
      search: null,
      order: line(name),
    });
    await applyOrders(env, [change(200, 'newer')]);
    await applyOrders(env, [change(100, 'older')]);
    expect((await row(sku))?.name).toBe('newer');
    // Within one batch, the newest per SKU wins too.
    await applyOrders(env, [change(400, 'newest'), change(300, 'between')]);
    expect(await row(sku)).toMatchObject({ name: 'newest', catalog_at: 400 });
  });
});
