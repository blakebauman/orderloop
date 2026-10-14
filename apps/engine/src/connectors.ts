/**
 * Mock commerce connectors over the D1 back office and R2. Each is the seam where a real adapter
 * (Stripe, a WMS, a carrier API, NetSuite) plugs in later. Every write is keyed by the step that
 * made it, so a retried step never double-books, and every compensation is idempotent.
 *
 * Failure simulation for demos and tests: set `order.meta.simulate` to one of
 * "payment_decline", "charge_fail", "out_of_stock", "three_way_mismatch".
 */

import {
  allocateLines,
  BASE_CURRENCY,
  checkAddress,
  money,
  newId,
  type Order,
  type OrderLine,
  type PriceRule,
  type PriceSource,
  type PriceSourceKind,
  rankStores,
  type StockLine,
  type StockSource,
  shipToPoint,
} from '@orderloop/core';
import {
  balanceEntries,
  contractPrices,
  createDb,
  customers,
  documents,
  entitlements,
  fxRates,
  locationStock,
  locations,
  messages,
  payments,
  payouts,
  priceRules,
  priceSources,
  products,
  reservations,
  sellerOrders,
  sellers,
  shipments,
  stockMovements,
} from '@orderloop/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

const db = (env: Env) => createDb(env.DB);
const simulate = (order: Order) => String(order.meta?.simulate ?? '');

export async function getCustomer(env: Env, id: string | undefined) {
  if (!id) return undefined;
  return db(env).query.customers.findFirst({ where: eq(customers.id, id) });
}

export async function findCustomerByName(env: Env, name: string) {
  const all = await db(env).select().from(customers);
  const needle = name.toLowerCase();
  return all.find(
    (c) => c.name.toLowerCase().includes(needle) || needle.includes(c.name.toLowerCase()),
  );
}

export async function getProducts(env: Env, skus?: string[]) {
  const q = db(env).select().from(products);
  return skus ? q.where(inArray(products.sku, skus)) : q;
}

/** Units of `currency` per one base currency, or null when there is no rate for it. */
export async function fxRate(env: Env, currency: string) {
  if (currency === BASE_CURRENCY) return 1;
  const row = await db(env).select().from(fxRates).where(eq(fxRates.currency, currency)).get();
  return row?.rate ?? null;
}

/**
 * The pricing chain for one customer: active sources, their entries, and the customer's tier.
 * Contract prices become the contract source's entries.
 */
export async function pricingFor(env: Env, customerId: string | undefined) {
  const d = db(env);
  const [sources, rules, contracts, customer] = await Promise.all([
    d.select().from(priceSources).where(eq(priceSources.active, true)),
    d.select().from(priceRules),
    customerId
      ? d.select().from(contractPrices).where(eq(contractPrices.customerId, customerId))
      : Promise.resolve([]),
    customerId
      ? d.select({ tier: customers.tier }).from(customers).where(eq(customers.id, customerId)).get()
      : Promise.resolve(undefined),
  ]);
  return {
    sources: sources.map(
      (s): PriceSource => ({
        id: s.id as PriceSourceKind,
        label: s.label,
        priority: s.priority,
        stopProcessing: s.stopProcessing,
      }),
    ),
    rules: [
      ...rules.map((r): PriceRule => ({ ...r, source: r.sourceId as PriceSourceKind })),
      ...contracts.map(
        (c): PriceRule => ({
          id: `contract_${c.customerId}_${c.sku}`,
          source: 'contract',
          name: 'Contract price',
          sku: c.sku,
          customerId: c.customerId,
          price: c.price,
        }),
      ),
    ],
    tier: customer?.tier ?? null,
  };
}

// ── Inventory ──────────────────────────────────────────────────────────────

/** Lines that hold stock, with their index in the order (digital goods hold none). */
async function stockedLines(env: Env, order: Order) {
  const bySku = new Map(
    (
      await getProducts(
        env,
        order.lines.map((l) => l.sku),
      )
    ).map((p) => [p.sku, p]),
  );
  return {
    bySku,
    lines: [...order.lines.entries()].filter(([, l]) => bySku.get(l.sku)?.kind !== 'digital'),
  };
}

/** Units free to hold per SKU: central stock, or a store's when `locationId` is set. */
async function available(env: Env, skus: string[], locationId?: string) {
  if (!skus.length) return new Map<string, number>();
  if (!locationId)
    return new Map((await getProducts(env, skus)).map((p) => [p.sku, p.stock - p.reserved]));
  const rows = await db(env)
    .select()
    .from(locationStock)
    .where(and(eq(locationStock.locationId, locationId), inArray(locationStock.sku, skus)));
  return new Map(rows.map((r) => [r.sku, r.stock - r.reserved]));
}

/**
 * Holds stock for every physical line: at the line's own store when routing split the shipment,
 * else at the store in `order.fulfillment` (pickup, carry-out, ship-from-store), else centrally.
 * Keyed by order, step and line.
 */
export async function reserveInventory(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const locationOf = (l: OrderLine) => l.locationId ?? order.fulfillment?.locationId;
  const idFor = (i: number, sku: string) =>
    `res_${order.id}_${stepKey}_${i}_${sku}`.replace(/[^\w-]/g, '_');
  const prefix = idFor(0, '').slice(0, -2);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, order.id), eq(reservations.status, 'held')));
  // Stock held by an earlier step (another loop run): the order already has it.
  const earlier = held.filter((r) => !r.id.startsWith(prefix));
  if (earlier.length) return { reservationIds: earlier.map((r) => r.id), short: [] as string[] };
  // Lines this step already held before it was retried count as available.
  const mine = new Set(held.map((r) => r.id));

  const { lines } = await stockedLines(env, order);
  const free = new Map<string | undefined, Map<string, number>>();
  for (const loc of new Set(lines.map(([, l]) => locationOf(l))))
    free.set(
      loc,
      await available(
        env,
        lines.filter(([, l]) => locationOf(l) === loc).map(([, l]) => l.sku),
        loc,
      ),
    );
  const short = lines
    .filter(([i, l]) => {
      if (mine.has(idFor(i, l.sku))) return false;
      return (
        simulate(order) === 'out_of_stock' || (free.get(locationOf(l))?.get(l.sku) ?? 0) < l.qty
      );
    })
    .map(([, l]) => l.sku);

  const reservationIds: string[] = [];
  for (const [i, line] of lines) {
    if (short.includes(line.sku)) continue;
    // Keyed by order, step and line, so neither another order nor a repeated SKU collides.
    const id = idFor(i, line.sku);
    const locationId = locationOf(line);
    await moveStock(
      env,
      { id, orderId: order.id, sku: line.sku, kind: 'hold', qty: line.qty, locationId },
      d
        .insert(reservations)
        .values({
          id,
          orderId: order.id,
          sku: line.sku,
          qty: line.qty,
          status: 'held',
          createdAt: Date.now(),
          locationId: locationId ?? null,
        })
        .onConflictDoNothing(),
    );
    reservationIds.push(id);
  }
  return { reservationIds, short };
}

/** The stock row a reservation was held against: the store's, or central. */
function stockRow(env: Env, r: { sku: string; locationId: string | null }) {
  const d = db(env);
  return {
    release: (qty: number) =>
      r.locationId
        ? d
            .update(locationStock)
            .set({ reserved: sql`max(0, ${locationStock.reserved} - ${qty})` })
            .where(and(eq(locationStock.locationId, r.locationId), eq(locationStock.sku, r.sku)))
        : d
            .update(products)
            .set({ reserved: sql`max(0, ${products.reserved} - ${qty})` })
            .where(eq(products.sku, r.sku)),
    consume: (qty: number) =>
      r.locationId
        ? d
            .update(locationStock)
            .set({
              stock: sql`${locationStock.stock} - ${qty}`,
              reserved: sql`max(0, ${locationStock.reserved} - ${qty})`,
            })
            .where(and(eq(locationStock.locationId, r.locationId), eq(locationStock.sku, r.sku)))
        : d
            .update(products)
            .set({
              stock: sql`${products.stock} - ${qty}`,
              reserved: sql`max(0, ${products.reserved} - ${qty})`,
            })
            .where(eq(products.sku, r.sku)),
  };
}

/** Compensation: release every held reservation for the order. Idempotent. */
export async function releaseInventory(env: Env, orderId: string) {
  const d = db(env);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'held')));
  for (const r of held) {
    await d.update(reservations).set({ status: 'released' }).where(eq(reservations.id, r.id));
    await stockRow(env, r).release(r.qty);
  }
  return held.length;
}

/** Shipping or handing goods over consumes held stock. */
export async function consumeInventory(env: Env, orderId: string) {
  const d = db(env);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'held')));
  for (const r of held) {
    await d.update(reservations).set({ status: 'consumed' }).where(eq(reservations.id, r.id));
    await stockRow(env, r).consume(r.qty);
  }
}

/** Adds returned or received stock to central stock, once per step and line. */
export async function restock(env: Env, orderId: string, stepKey: string, lines: StockLine[]) {
  for (const [i, l] of lines.entries()) {
    const id = `stk_${orderId}_${stepKey}_${i}_${l.sku}`.replace(/[^\w-]/g, '_');
    await moveStock(env, { id, orderId, sku: l.sku, kind: 'restock', qty: l.qty });
  }
}

/**
 * Records one inventory change in the ledger and applies it in the same batch, only if it hasn't
 * been applied yet. D1 runs a batch as one transaction, so a crash can't leave the ledger and the
 * stock row disagreeing, and a retry with the same id changes nothing. `first` runs at the start
 * of the batch (the reservation row for a hold). A `locationId` moves a store's stock instead of
 * central stock.
 */
async function moveStock(
  env: Env,
  m: {
    id: string;
    orderId: string;
    sku: string;
    kind: 'hold' | 'restock';
    qty: number;
    locationId?: string;
  },
  first?: BatchItem<'sqlite'>,
) {
  const d = db(env);
  const pending = sql`exists (select 1 from ${stockMovements} where ${and(eq(stockMovements.id, m.id), eq(stockMovements.applied, false))})`;
  const record = d
    .insert(stockMovements)
    .values({ ...m, locationId: m.locationId ?? null, createdAt: Date.now() })
    .onConflictDoNothing();
  const apply = m.locationId
    ? d
        .update(locationStock)
        .set(
          m.kind === 'hold'
            ? { reserved: sql`${locationStock.reserved} + ${m.qty}` }
            : { stock: sql`${locationStock.stock} + ${m.qty}` },
        )
        .where(
          and(eq(locationStock.locationId, m.locationId), eq(locationStock.sku, m.sku), pending),
        )
    : d
        .update(products)
        .set(
          m.kind === 'hold'
            ? { reserved: sql`${products.reserved} + ${m.qty}` }
            : { stock: sql`${products.stock} + ${m.qty}` },
        )
        .where(and(eq(products.sku, m.sku), pending));
  const mark = d.update(stockMovements).set({ applied: true }).where(eq(stockMovements.id, m.id));
  await (first ? d.batch([first, record, apply, mark]) : d.batch([record, apply, mark]));
}

// ── Fulfillment ────────────────────────────────────────────────────────────

export type Routing = {
  /** Branches to take: one physical method (or unavailable), plus digital when there are digital lines. */
  branches: string[];
  method: 'ship' | 'pickup' | 'carry_out' | null;
  locationId?: string;
  locationName?: string;
  /** A split shipment: where each part ships from (`locationId` null is central stock). */
  sources?: { locationId: string | null; name: string; lines: number[] }[];
  reason?: string;
};

/**
 * Where the physical lines come from: central stock first for shipping, then the first store
 * that ships and has every line (ship-from-store); for pickup and carry-out, the order's store,
 * which must hold every line. Reads only; reserving happens in its own step.
 */
export async function routeFulfillment(
  env: Env,
  order: Order,
  method: 'ship' | 'pickup' | 'carry_out',
): Promise<Routing> {
  const { bySku, lines } = await stockedLines(env, order);
  const digital = order.lines.some((l) => bySku.get(l.sku)?.kind === 'digital');
  const done = (r: Omit<Routing, 'branches'> & { branch: string }): Routing => ({
    ...r,
    branches: [r.branch, ...(digital ? ['digital'] : [])],
  });
  if (!lines.length) return { branches: ['digital'], method: null };
  const covers = (free: Map<string, number>) =>
    lines.every(([, l]) => (free.get(l.sku) ?? 0) >= l.qty);
  const skus = lines.map(([, l]) => l.sku);
  const stores = await db(env).select().from(locations).orderBy(locations.id);
  if (method === 'ship') {
    // Central stock first, then the shipping stores nearest the customer.
    const sources: StockSource[] = [
      { id: null, name: 'Warehouse', free: await available(env, skus) },
    ];
    for (const store of rankStores(
      stores.filter((s) => s.ships),
      shipToPoint(order),
    ))
      sources.push({ id: store.id, name: store.name, free: await available(env, skus, store.id) });
    const a = allocateLines(
      lines.map(([index, l]) => ({ index, sku: l.sku, qty: l.qty })),
      sources,
    );
    if (a.kind === 'unavailable')
      return done({
        branch: 'unavailable',
        method,
        reason: `No warehouse or store has enough ${a.short.join(', ')}`,
      });
    if (a.kind === 'whole')
      return done({
        branch: 'ship',
        method,
        ...(a.source.id ? { locationId: a.source.id, locationName: a.source.name } : {}),
      });
    const parts = new Map<StockSource, number[]>();
    for (const [index, source] of a.lines) parts.set(source, [...(parts.get(source) ?? []), index]);
    return done({
      branch: 'ship',
      method,
      sources: [...parts].map(([source, idx]) => ({
        locationId: source.id,
        name: source.name,
        lines: idx,
      })),
    });
  }
  const store = stores.find((s) => s.id === order.fulfillment?.locationId);
  if (!store || (method === 'pickup' && !store.pickup))
    return done({
      branch: 'unavailable',
      method,
      reason: store ? `${store.name} does not offer pickup` : 'No store given for the order',
    });
  if (!covers(await available(env, skus, store.id)))
    return done({
      branch: 'unavailable',
      method,
      reason: `${store.name} does not have every item`,
    });
  return done({ branch: method, method, locationId: store.id, locationName: store.name });
}

/** Stages held stock for collection: a pickup "shipment" whose tracking is the pickup code. */
export async function stagePickup(env: Env, order: Order, stepKey: string) {
  const id = `pkp_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const code = Math.abs(hash(id)).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
  await db(env)
    .insert(shipments)
    .values({
      id,
      orderId: order.id,
      carrier: 'pickup',
      tracking: code,
      status: 'ready_for_pickup',
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  return { shipmentId: id, pickupCode: code };
}

/**
 * The customer has the goods: consumes held stock and marks a staged pickup collected, or records
 * a carry-out. Keyed by step.
 */
export async function handOver(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const staged = await d
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), eq(shipments.status, 'ready_for_pickup')));
  if (staged.length)
    await d
      .update(shipments)
      .set({ status: 'collected' })
      .where(
        inArray(
          shipments.id,
          staged.map((s) => s.id),
        ),
      );
  else
    await d
      .insert(shipments)
      .values({
        id: `hnd_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_'),
        orderId: order.id,
        carrier: 'carry_out',
        tracking: order.fulfillment?.locationId ?? 'store',
        status: 'collected',
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
  await consumeInventory(env, order.id);
  return { collected: staged.length ? 'pickup' : 'carry_out' };
}

/** One code per unit of each digital line, keyed by step, line and unit. */
export async function issueEntitlements(env: Env, order: Order, stepKey: string) {
  const { bySku } = await stockedLines(env, order);
  const now = Date.now();
  const out = [];
  for (const [i, l] of order.lines.entries()) {
    if (bySku.get(l.sku)?.kind !== 'digital') continue;
    for (let n = 0; n < l.qty; n++) {
      const id = `ent_${order.id}_${stepKey}_${i}_${n}`.replace(/[^\w-]/g, '_');
      const h = Math.abs(hash(id)).toString(36).toUpperCase().padStart(8, '0');
      const row = {
        id,
        orderId: order.id,
        sku: l.sku,
        code: `${l.sku}-${h.slice(0, 4)}-${h.slice(4, 8)}`,
        status: 'issued',
        createdAt: now,
      };
      await db(env).insert(entitlements).values(row).onConflictDoNothing();
      out.push({ sku: row.sku, code: row.code });
    }
  }
  return out;
}

/** Compensation: revokes the order's digital goods. Idempotent. */
export async function revokeEntitlements(env: Env, orderId: string) {
  const res = await db(env)
    .update(entitlements)
    .set({ status: 'revoked' })
    .where(and(eq(entitlements.orderId, orderId), eq(entitlements.status, 'issued')))
    .returning();
  return res.length;
}

export async function lowStock(env: Env) {
  const all = await getProducts(env);
  return all.filter((p) => p.stock - p.reserved <= p.reorderPoint);
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** Checks a ship-to. The mock is the deterministic core validator; a USPS or Loqate call goes here. */
export async function validateAddress(_env: Env, shipTo: unknown) {
  return checkAddress(shipTo);
}

// ── Payments ───────────────────────────────────────────────────────────────

async function recordPayment(
  env: Env,
  id: string,
  orderId: string,
  kind: string,
  amount: number,
  status: string,
  ref?: string,
) {
  await db(env)
    .insert(payments)
    .values({ id, orderId, kind, amount, status, ref, createdAt: Date.now() })
    .onConflictDoNothing();
  return { paymentId: id, amount, status };
}

export async function authorizePayment(env: Env, order: Order, stepKey: string, method: string) {
  const declined = simulate(order) === 'payment_decline';
  return recordPayment(
    env,
    `pay_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_'),
    order.id,
    `authorization:${method}`,
    order.total,
    declined ? 'declined' : 'authorized',
  );
}

/** Compensation: void every open authorization for the order. Idempotent. */
export async function voidAuthorizations(env: Env, orderId: string) {
  const res = await db(env)
    .update(payments)
    .set({ status: 'voided' })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'authorized')))
    .returning();
  return res.length;
}

export async function capturePayment(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const [auth] = await d
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.status, 'authorized')));
  if (!auth) return { paymentId: null, amount: 0, status: 'failed' };
  await d.update(payments).set({ status: 'captured' }).where(eq(payments.id, auth.id));
  // Never more than the order now costs: lines dropped after authorizing (a seller rejecting
  // their part) are released, not charged.
  return recordPayment(
    env,
    `cap_${stepKey}_${order.id}`.replace(/[^\w-]/g, '_'),
    order.id,
    'capture',
    money(Math.min(auth.amount, order.total)),
    'succeeded',
    auth.id,
  );
}

export async function charge(env: Env, order: Order, stepKey: string) {
  const fail = simulate(order) === 'charge_fail';
  return recordPayment(
    env,
    `chg_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_'),
    order.id,
    'charge',
    order.total,
    fail ? 'failed' : 'succeeded',
  );
}

/**
 * Refunds up to `requested` (everything still refundable when omitted) of the money captured or
 * charged on the order. Keyed by step: a retried step returns the refund it already made.
 */
export async function refund(env: Env, order: Order, stepKey: string, requested?: number) {
  const d = db(env);
  const id = `rfd_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const done = await d.select().from(payments).where(eq(payments.id, id)).get();
  if (done) return { paymentId: id, amount: done.amount, status: done.status };

  const rows = await d.select().from(payments).where(eq(payments.orderId, order.id));
  const paid = rows
    .filter((p) => p.status === 'succeeded' && (p.kind === 'capture' || p.kind === 'charge'))
    .reduce((s, p) => s + p.amount, 0);
  const refunded = rows
    .filter((p) => p.kind === 'refund' && p.status === 'succeeded')
    .reduce((s, p) => s + p.amount, 0);
  const refundable = money(paid - refunded);
  const amount = money(Math.min(requested ?? refundable, refundable));
  if (amount <= 0) return { paymentId: null, amount: 0, status: 'failed' };
  return recordPayment(env, id, order.id, 'refund', amount, 'succeeded');
}

/** Money captured or charged on the order, before refunds. */
export async function paidAmount(env: Env, orderId: string) {
  const rows = await db(env).select().from(payments).where(eq(payments.orderId, orderId));
  return money(
    rows
      .filter((p) => p.status === 'succeeded' && (p.kind === 'capture' || p.kind === 'charge'))
      .reduce((s, p) => s + p.amount, 0),
  );
}

/**
 * Adds to a customer's balance once per order and step: the ledger row and the balance update run
 * in one batch, and the update only applies while the row is unapplied, so a retried step changes
 * nothing.
 */
export async function addToBalance(
  env: Env,
  e: { orderId: string; stepKey: string; customerId: string; amount: number },
) {
  const d = db(env);
  const id = `bal_${e.orderId}_${e.stepKey}`.replace(/[^\w-]/g, '_');
  const pending = and(eq(balanceEntries.id, id), eq(balanceEntries.applied, false));
  await d.batch([
    d
      .insert(balanceEntries)
      .values({
        id,
        orderId: e.orderId,
        customerId: e.customerId,
        amount: e.amount,
        createdAt: Date.now(),
      })
      .onConflictDoNothing(),
    d
      .update(customers)
      .set({ balance: sql`${customers.balance} + ${e.amount}` })
      .where(
        and(
          eq(customers.id, e.customerId),
          sql`exists (select 1 from ${balanceEntries} where ${pending})`,
        ),
      ),
    d.update(balanceEntries).set({ applied: true }).where(eq(balanceEntries.id, id)),
  ]);
}

// ── Marketplace ────────────────────────────────────────────────────────────

/** The seller id for lines the marketplace operator sells itself. */
export const FIRST_PARTY = 'first_party';

export type SellerPart = {
  sellerId: string;
  name: string;
  status: string;
  subtotal: number;
  reason: string | null;
};

/**
 * One seller order per seller on the order: a line's own `sellerId`, else its product's seller,
 * else first party. First-party lines and sellers that auto-accept start accepted. Keyed by order
 * and seller, so a retried step changes nothing.
 */
export async function splitBySeller(env: Env, order: Order) {
  const d = db(env);
  const skus = order.lines.map((l) => l.sku);
  const bySku = new Map((await getProducts(env, skus)).map((p) => [p.sku, p]));
  const groups = new Map<string, OrderLine[]>();
  for (const l of order.lines) {
    const seller = l.sellerId ?? bySku.get(l.sku)?.sellerId ?? FIRST_PARTY;
    groups.set(seller, [...(groups.get(seller) ?? []), l]);
  }
  const ids = [...groups.keys()].filter((id) => id !== FIRST_PARTY);
  const known = new Map(
    (ids.length ? await d.select().from(sellers).where(inArray(sellers.id, ids)) : []).map((s) => [
      s.id,
      s,
    ]),
  );
  const missing = ids.filter((id) => !known.get(id)?.active);
  if (missing.length)
    return { ok: false, error: `Unknown or inactive seller: ${missing.join(', ')}` } as const;
  const now = Date.now();
  for (const [sellerId, lines] of groups) {
    const seller = known.get(sellerId);
    const accepted = sellerId === FIRST_PARTY || !!seller?.autoAccept;
    await d
      .insert(sellerOrders)
      .values({
        id: `so_${order.id}_${sellerId}`,
        orderId: order.id,
        sellerId,
        status: accepted ? 'accepted' : 'pending',
        lines: JSON.stringify(lines),
        subtotal: money(lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0)),
        createdAt: now,
        decidedAt: accepted ? now : null,
      })
      .onConflictDoNothing();
  }
  return { ok: true, parts: await sellerParts(env, order.id) } as const;
}

export async function sellerParts(env: Env, orderId: string): Promise<SellerPart[]> {
  const rows = await db(env)
    .select({
      sellerId: sellerOrders.sellerId,
      name: sellers.name,
      status: sellerOrders.status,
      subtotal: sellerOrders.subtotal,
      reason: sellerOrders.reason,
    })
    .from(sellerOrders)
    .leftJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
    .where(eq(sellerOrders.orderId, orderId))
    .orderBy(sellerOrders.sellerId);
  return rows.map((r) => ({ ...r, name: r.name ?? 'Marketplace' }));
}

/** Accepts or rejects a seller's part. Only a pending part changes, so a replay is a no-op. */
export async function decideSellerOrder(
  env: Env,
  orderId: string,
  sellerId: string,
  decision: 'accepted' | 'rejected',
  reason?: string,
) {
  await db(env)
    .update(sellerOrders)
    .set({ status: decision, reason: reason ?? null, decidedAt: Date.now() })
    .where(
      and(
        eq(sellerOrders.orderId, orderId),
        eq(sellerOrders.sellerId, sellerId),
        eq(sellerOrders.status, 'pending'),
      ),
    );
}

/** Rejects every part still pending. */
export async function expireSellerOrders(env: Env, orderId: string, reason: string) {
  const res = await db(env)
    .update(sellerOrders)
    .set({ status: 'rejected', reason, decidedAt: Date.now() })
    .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'pending')))
    .returning();
  return res.length;
}

/** Compensation: cancels every part not already rejected. Idempotent. */
export async function cancelSellerOrders(env: Env, orderId: string) {
  const res = await db(env)
    .update(sellerOrders)
    .set({ status: 'cancelled' })
    .where(
      and(eq(sellerOrders.orderId, orderId), inArray(sellerOrders.status, ['pending', 'accepted'])),
    )
    .returning();
  return res.length;
}

/**
 * Emails of the third-party sellers to tell: those still to answer when any are, else those who
 * accepted.
 */
export async function sellerContacts(env: Env, orderId: string) {
  const rows = await db(env)
    .select({ id: sellers.id, email: sellers.email, status: sellerOrders.status })
    .from(sellerOrders)
    .innerJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
    .where(eq(sellerOrders.orderId, orderId))
    .orderBy(sellers.id);
  const pending = rows.filter((r) => r.status === 'pending');
  return pending.length ? pending : rows.filter((r) => r.status === 'accepted');
}

/**
 * One payout per accepted third-party seller: their lines, less their share of refunds so far
 * (pro rata to the order total) and the commission on what is left. Keyed by step and seller.
 */
export async function schedulePayouts(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const parts = await d
    .select({ part: sellerOrders, pct: sellers.commissionPct })
    .from(sellerOrders)
    .innerJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
    .where(and(eq(sellerOrders.orderId, order.id), eq(sellerOrders.status, 'accepted')));
  const refunds = (await d.select().from(payments).where(eq(payments.orderId, order.id)))
    .filter((p) => p.kind === 'refund' && p.status === 'succeeded')
    .reduce((s, p) => s + p.amount, 0);
  const now = Date.now();
  const out = [];
  for (const { part, pct } of parts) {
    const gross = part.subtotal;
    const refunded = order.total > 0 ? money(Math.min(gross, (refunds * gross) / order.total)) : 0;
    const commission = money((gross - refunded) * pct);
    const row = {
      id: `pout_${order.id}_${stepKey}_${part.sellerId}`.replace(/[^\w-]/g, '_'),
      orderId: order.id,
      sellerId: part.sellerId,
      gross,
      commission,
      refunded,
      net: money(gross - refunded - commission),
      status: 'scheduled',
      createdAt: now,
    };
    await d.insert(payouts).values(row).onConflictDoNothing();
    out.push(row);
  }
  return out;
}

/** Compensation: reverses payouts that have not been paid. Idempotent. */
export async function reversePayouts(env: Env, orderId: string) {
  const res = await db(env)
    .update(payouts)
    .set({ status: 'reversed' })
    .where(and(eq(payouts.orderId, orderId), eq(payouts.status, 'scheduled')))
    .returning();
  return res.length;
}

// ── Shipping ───────────────────────────────────────────────────────────────

/**
 * Books one shipment per location the physical lines ship from (one, unless routing split the
 * order), then consumes the held stock. The first shipment keeps the step's id, so a single-source
 * order books exactly what it always did; the groups come from the order, so a retry books the same.
 */
export async function createShipment(env: Env, order: Order, stepKey: string, carrier: string) {
  const base = `shp_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const { lines } = await stockedLines(env, order);
  const from = [
    ...new Set(lines.map(([, l]) => l.locationId ?? order.fulfillment?.locationId ?? null)),
  ].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  const out = [];
  for (const [n, locationId] of (from.length ? from : [null]).entries()) {
    const id = n === 0 ? base : `${base}_${n + 1}`;
    const tracking = `${carrier.toUpperCase()}${Math.abs(hash(id)).toString().padStart(10, '0').slice(0, 10)}`;
    await db(env)
      .insert(shipments)
      .values({
        id,
        orderId: order.id,
        carrier,
        tracking,
        status: 'label_created',
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
    out.push({ shipmentId: id, tracking, locationId });
  }
  await consumeInventory(env, order.id);
  return {
    shipmentId: out[0]!.shipmentId,
    carrier,
    tracking: out[0]!.tracking,
    shipments: out,
  };
}

/** A prepaid return label. Stock comes back with `restock` once the goods arrive. */
export async function createReturnLabel(env: Env, order: Order, stepKey: string, carrier: string) {
  const id = `rma_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const tracking = `${carrier.toUpperCase()}R${Math.abs(hash(id)).toString().padStart(9, '0').slice(0, 9)}`;
  await db(env)
    .insert(shipments)
    .values({
      id,
      orderId: order.id,
      carrier,
      tracking,
      status: 'return_label',
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  return { rmaId: id, carrier, tracking };
}

/** Compensation: cancel a shipment that was booked by this step. */
export async function cancelShipment(env: Env, shipmentId: string) {
  await db(env).update(shipments).set({ status: 'cancelled' }).where(eq(shipments.id, shipmentId));
}

export async function cancelOpenShipments(env: Env, orderId: string) {
  const res = await db(env)
    .update(shipments)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(shipments.orderId, orderId),
        inArray(shipments.status, ['label_created', 'ready_for_pickup']),
      ),
    )
    .returning();
  return res.length;
}

// ── Documents (R2) and outbox ────────────────────────────────────────────────

export async function storeDocument(
  env: Env,
  orderId: string,
  kind: string,
  name: string,
  body: string,
  contentType = 'text/html; charset=utf-8',
) {
  const key = `orders/${orderId}/${kind}/${name}`;
  await env.DOCS.put(key, body, { httpMetadata: { contentType } });
  await db(env)
    .insert(documents)
    .values({ id: key, orderId, kind, r2Key: key, contentType, createdAt: Date.now() })
    .onConflictDoNothing();
  return key;
}

export async function sendMessage(
  env: Env,
  orderId: string,
  stepKey: string,
  recipient: string,
  subject: string,
  body: string,
) {
  const id = `msg_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');
  await db(env)
    .insert(messages)
    .values({ id, orderId, recipient, subject, body, createdAt: Date.now() })
    .onConflictDoNothing();
  return { messageId: id, recipient, subject };
}

export function renderDocument(title: string, order: Order, extra: Record<string, string> = {}) {
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency });
  const cash = (n: number) => esc(fmt.format(n));
  const rows = order.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.sku)}</td><td>${esc(l.name ?? '')}</td><td>${l.qty}</td><td>${cash(l.unitPrice ?? 0)}</td><td>${cash(money(l.qty * (l.unitPrice ?? 0)))}</td></tr>`,
    )
    .join('');
  const meta = Object.entries(extra)
    .map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v)}</p>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px system-ui;margin:40px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}</style>
<h1>${esc(title)}</h1><p>Order ${esc(order.id)} · ${new Date().toISOString().slice(0, 10)}</p>${meta}
<table><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit</th><th>Line</th></tr>${rows}</table>
<p>Subtotal ${cash(order.subtotal)} · Tax ${cash(order.tax)} · <b>Total ${cash(order.total)} ${esc(order.currency)}</b></p>`;
}

/** Undo everything compensable for an order (cancel path; Workflow rollback covers failures). */
export async function compensateOrder(env: Env, orderId: string) {
  const [released, voided, cancelled, sellerOrdersCancelled, payoutsReversed, revoked] =
    await Promise.all([
      releaseInventory(env, orderId),
      voidAuthorizations(env, orderId),
      cancelOpenShipments(env, orderId),
      cancelSellerOrders(env, orderId),
      reversePayouts(env, orderId),
      revokeEntitlements(env, orderId),
    ]);
  return { released, voided, cancelled, sellerOrdersCancelled, payoutsReversed, revoked };
}

export const idFor = newId;

function esc(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
