import { env } from 'cloudflare:workers';
import {
  b2bOrderFlow,
  type Order,
  omnichannelOrderFlow,
  type RunContext,
  storefrontOrderFlow,
  withDefaults,
} from '@orderloop/core';
import { createDb, promotionRedemptions, promotions } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXECUTORS, ROLLBACKS } from '../src/nodes';

const db = () => createDb(env.DB);
const now = Date.now();

const order = (o: Partial<Order> = {}): Order => ({
  id: `ord_promo_${crypto.randomUUID().slice(0, 8)}`,
  model: 'b2c',
  channel: 'web',
  currency: 'USD',
  customerId: 'cus_northwind',
  lines: [
    { sku: 'WID-100', qty: 2, unitPrice: 50 },
    { sku: 'GSK-010', qty: 1, unitPrice: 100 },
  ],
  meta: { promoCodes: ['save10'] },
  createdAt: now,
  subtotal: 200,
  shipping: 15,
  tax: 0,
  total: 215,
  fxRate: 1,
  ...o,
});

const node = {
  id: 'promo',
  type: 'commerce.discount',
  label: 'Promotions',
  config: {},
  position: { x: 0, y: 0 },
};
async function discount(o: Order, config: Record<string, unknown> = {}, extra = {}) {
  const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now, ref: o.id };
  return EXECUTORS['commerce.discount']!({
    env,
    node,
    config: withDefaults('commerce.discount', config),
    ctx,
    stepKey: 'promo#1',
    ...extra,
  });
}

async function addPromotion(p: Partial<typeof promotions.$inferInsert> & { code: string }) {
  await db()
    .insert(promotions)
    .values({ id: `promo_${p.code}`, kind: 'pct', value: 10, createdAt: now, updatedAt: now, ...p })
    .onConflictDoNothing();
}

const redemptions = (code: string) =>
  db()
    .select()
    .from(promotionRedemptions)
    .where(eq(promotionRedemptions.promotionId, `promo_${code}`))
    .all();

beforeEach(async () => {
  await db().delete(promotionRedemptions);
  await db().delete(promotions);
});

describe('commerce.discount', () => {
  it('applies a code to the lines and records one redemption per order', async () => {
    await addPromotion({ code: 'SAVE10' });
    const o = order();
    const r = await discount(o);
    expect(r.order?.lines?.map((l) => l.unitPrice)).toEqual([45, 90]);
    expect(r.order).toMatchObject({ subtotal: 180, shipping: 15, total: 195 });
    expect(r.summary).toBe('SAVE10 · $20.00 off');
    // A retried step holds the same redemption.
    await discount(o);
    expect(await redemptions('SAVE10')).toEqual([
      expect.objectContaining({
        orderId: o.id,
        customerId: 'cus_northwind',
        amount: 20,
        stepKey: 'promo#1',
      }),
    ]);
  });

  it('never redeems when pricing a quote', async () => {
    await addPromotion({ code: 'SAVE10' });
    const r = await discount(order(), {}, { dryRun: true });
    expect(r.order?.subtotal).toBe(180);
    expect(await redemptions('SAVE10')).toEqual([]);
  });

  // The refusals come in the order the codes were given, so their order shows nothing about which
  // codes exist.
  it('refuses a code that is unknown, expired or used up, and leaves the order as it was', async () => {
    await addPromotion({ code: 'OLD', validTo: now - 1 });
    await addPromotion({ code: 'ONCE', maxRedemptions: 1 });
    const first = await discount(order({ meta: { promoCodes: ['ONCE'] } }));
    expect(first.summary).toMatch(/ONCE/);
    const second = await discount(order({ meta: { promoCodes: ['ONCE', 'OLD', 'NOPE'] } }));
    expect(second.order?.subtotal).toBe(200);
    expect(
      (second.output as { refused: { reason: string }[] }).refused.map((r) => r.reason),
    ).toEqual(['ONCE has been used up.', 'OLD has expired.', "NOPE isn't a promotion."]);
    expect(await redemptions('ONCE')).toHaveLength(1);
  });

  it('makes shipping free, and applies only the best code unless they stack', async () => {
    await addPromotion({ code: 'SHIP', kind: 'free_shipping', value: 0 });
    await addPromotion({ code: 'SAVE10' });
    const best = await discount(order({ meta: { promoCodes: ['SHIP', 'SAVE10'] } }));
    expect((best.output as { applied: { code: string }[] }).applied.map((a) => a.code)).toEqual([
      'SAVE10',
    ]);
    const both = await discount(order({ meta: { promoCodes: ['SHIP', 'SAVE10'] } }), {
      stack: true,
    });
    expect(both.order).toMatchObject({ subtotal: 180, shipping: 0, total: 180 });
  });

  it('gives redemptions back when the order rolls back', async () => {
    await addPromotion({ code: 'SAVE10' });
    const o = order();
    await discount(o);
    expect(await ROLLBACKS['commerce.discount']!(env, o.id, undefined, 'promo#1')).toBe(
      'Gave back 1 promotion redemption',
    );
    expect(await ROLLBACKS['commerce.discount']!(env, o.id, undefined, 'promo#1')).toBe(
      'No promotions to give back',
    );
  });
});

describe('commerce.tax by region', () => {
  it('uses the ship-to region’s rate, else the node’s', async () => {
    const tax = async (shipTo: Record<string, string>) => {
      const o = order({ meta: { shipTo } });
      const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now, ref: o.id };
      const r = await EXECUTORS['commerce.tax']!({
        env,
        node: {
          id: 'tax',
          type: 'commerce.tax',
          label: 'Tax',
          config: {},
          position: { x: 0, y: 0 },
        },
        config: withDefaults('commerce.tax', {
          rate: 0.1,
          includeShipping: false,
          regions: [
            { country: 'US', region: 'CA', rate: 0.05 },
            { country: 'US', rate: 0.07 },
          ],
        }),
        ctx,
        stepKey: 'tax#1',
      });
      return r.order?.tax;
    };
    const addr = { line1: '1 Main St', city: 'Town', postalCode: '94607' };
    expect(await tax({ ...addr, region: 'CA', country: 'US' })).toBe(10);
    expect(await tax({ ...addr, region: 'NY', country: 'US' })).toBe(14);
    expect(await tax({ ...addr, country: 'DE' })).toBe(20);
  });
});

// The built-in flows that take codes run it in their checkout quote, so a quote is discounted too.
it('is a pricing node the checkout quote runs', async () => {
  const { quoteNodes } = await import('@orderloop/core');
  for (const flow of [b2bOrderFlow(), storefrontOrderFlow(), omnichannelOrderFlow()])
    expect([flow.id, quoteNodes(flow).map((n) => n.type)]).toEqual([
      flow.id,
      expect.arrayContaining(['commerce.discount']),
    ]);
});
