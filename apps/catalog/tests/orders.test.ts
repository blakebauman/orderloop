import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOrders } from '../src/orders';
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

  it('carries a variant’s shipping weight and size, and a change without them keeps the row’s', async () => {
    const p = product({
      title: { en: 'Duffel' },
      variants: [
        {
          sku: `${Date.now()}-duffel`,
          attributes: { size: 'L' },
          weightKg: 1.2,
          dimensionsCm: { length: 60, width: 30, height: 30 },
        },
      ],
    });
    const sku = p.variants[0]!.sku;
    await api.putProducts([p], { by });
    await settle();
    const sized = () =>
      env.DB.prepare(
        'SELECT name, weight_kg, length_cm, width_cm, height_cm FROM products WHERE sku = ?',
      )
        .bind(sku)
        .first();
    await until(sku, (r) => !!r);
    expect(await sized()).toEqual({
      name: 'Duffel (L)',
      weight_kg: 1.2,
      length_cm: 60,
      width_cm: 30,
      height_cm: 30,
    });
    // A newer change sent without them (one queued before they existed) renames, and keeps them.
    await applyOrders(env, [
      {
        channel: 'web',
        key: p.key,
        at: Date.now() + 60_000,
        entry: null,
        left: [],
        search: null,
        order: [{ sku, name: 'Duffel bag', price: 1 }],
      },
    ]);
    expect(await sized()).toMatchObject({ name: 'Duffel bag', weight_kg: 1.2, height_cm: 30 });
  });

  it('never lets an older change overwrite a newer one', async () => {
    const sku = `order-${Date.now()}`;
    const line = (name: string) => [{ sku, name, price: 1 }];
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
