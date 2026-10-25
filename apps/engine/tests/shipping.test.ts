import { env } from 'cloudflare:workers';
import { type Order, type RunContext, withDefaults } from '@orderloop/core';
import { createDb, products } from '@orderloop/db';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXECUTORS } from '../src/nodes';

const now = Date.now();

// Per unit: a light, bulky box (1 kg; 50 × 40 × 30 cm is 12 kg at 5000 cm³/kg), a dense brick
// (8 kg in 20 × 10 × 10 cm, 0.4 kg by size), and a part with no weight or size on record.
beforeAll(async () => {
  await createDb(env.DB)
    .insert(products)
    .values([
      {
        sku: 'DIM-BOX',
        name: 'Bulky box',
        price: 10,
        cost: 1,
        stock: 100,
        weightKg: 1,
        lengthCm: 50,
        widthCm: 40,
        heightCm: 30,
      },
      {
        sku: 'DIM-BRICK',
        name: 'Brick',
        price: 10,
        cost: 1,
        stock: 100,
        weightKg: 8,
        lengthCm: 20,
        widthCm: 10,
        heightCm: 10,
      },
      { sku: 'DIM-BARE', name: 'Bare part', price: 10, cost: 1, stock: 100 },
    ])
    .onConflictDoNothing();
});

afterEach(() => vi.restoreAllMocks());

const order = (lines: Order['lines']): Order => ({
  id: `ord_dim_${crypto.randomUUID().slice(0, 8)}`,
  model: 'b2c',
  channel: 'web',
  currency: 'USD',
  customerId: 'cus_ada',
  lines,
  meta: {},
  createdAt: now,
  subtotal: lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0),
  shipping: 0,
  tax: 0,
  total: 0,
  fxRate: 1,
});

const service = {
  id: 'ground',
  title: 'Ground',
  carrier: 'ups',
  base: 5,
  perItem: 1,
  perKg: 0.5,
  minDays: 2,
  maxDays: 4,
};

async function rate(o: Order, rates: Record<string, unknown>) {
  const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now, ref: o.id };
  return EXECUTORS['commerce.shipping_rate']!({
    env,
    node: {
      id: 'shipping',
      type: 'commerce.shipping_rate',
      label: 'Shipping',
      config: {},
      position: { x: 0, y: 0 },
    },
    config: withDefaults('commerce.shipping_rate', { rates, select: 'cheapest' }),
    ctx,
    stepKey: 'shipping#1',
  });
}

describe('commerce.shipping_rate by weight', () => {
  it('rates by units by default, ignoring weight, size and perKg', async () => {
    const r = await rate(order([{ sku: 'DIM-BOX', qty: 2, unitPrice: 10 }]), {
      services: [service],
    });
    // 5 + 1 × 2: the 24 billable kg are never charged.
    expect(r.order?.shipping).toBe(7);
    expect(r.output).toMatchObject({ units: 2, source: 'static' });
    expect(r.output).not.toHaveProperty('billableKg');
    expect(r.output).not.toHaveProperty('basis');
  });

  it('charges dimensional weight when it beats actual weight, and actual weight otherwise', async () => {
    const r = await rate(
      order([
        { sku: 'DIM-BOX', qty: 2, unitPrice: 10 },
        { sku: 'DIM-BRICK', qty: 1, unitPrice: 10 },
      ]),
      { basis: 'dim_weight', services: [service] },
    );
    // 2 × 12 (dimensional) + 8 (actual) = 32 kg; 5 + 1 × 3 + 0.5 × 32 = 24.
    expect(r.output).toMatchObject({
      basis: 'dim_weight',
      billableKg: 32,
      estimatedUnits: 0,
      units: 3,
    });
    expect(r.order?.shipping).toBe(24);

    // By weight alone the box is 1 kg: 2 + 8 = 10 kg; 5 + 3 + 5 = 13.
    const w = await rate(
      order([
        { sku: 'DIM-BOX', qty: 2, unitPrice: 10 },
        { sku: 'DIM-BRICK', qty: 1, unitPrice: 10 },
      ]),
      { basis: 'weight', services: [service] },
    );
    expect(w.output).toMatchObject({ basis: 'weight', billableKg: 10 });
    expect(w.order?.shipping).toBe(13);
  });

  it('counts defaultKg for a product with no weight or size, and says how many units it guessed', async () => {
    const r = await rate(
      order([
        { sku: 'DIM-BARE', qty: 3, unitPrice: 10 },
        { sku: 'DIM-BRICK', qty: 1, unitPrice: 10 },
        // Digital goods don't ship, so they are neither units nor weight.
        { sku: 'EBK-101', qty: 1, unitPrice: 18 },
      ]),
      { basis: 'dim_weight', defaultKg: 2, services: [service] },
    );
    // 3 × 2 (default) + 8 = 14 kg; 5 + 1 × 4 + 0.5 × 14 = 16.
    expect(r.output).toMatchObject({ units: 4, billableKg: 14, estimatedUnits: 3 });
    expect(r.order?.shipping).toBe(16);
  });

  it('sends live carriers the billable weight only when the basis weighs units', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ options: [{ id: 'ground', amount: 9 }] });
    });
    const liveCarriers = [{ id: 'acme', carrier: 'acme', url: 'https://rates.example/quote' }];
    const lines = [{ sku: 'DIM-BOX', qty: 1, unitPrice: 10 }];
    const weighed = await rate(order(lines), {
      basis: 'dim_weight',
      services: [service],
      liveCarriers,
    });
    expect(weighed.output).toMatchObject({ source: 'live', billableKg: 12 });
    await rate(order(lines), { services: [service], liveCarriers });
    expect(bodies[0]).toMatchObject({ itemCount: 1, billableKg: 12, currency: 'USD' });
    // An existing carrier sees the request it always did.
    expect(bodies[1]).toEqual({ itemCount: 1, country: null, subtotal: 10, currency: 'USD' });
  });
});
