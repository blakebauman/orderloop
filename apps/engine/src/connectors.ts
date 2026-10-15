/**
 * Mock commerce connectors over the D1 back office and R2. Each is the seam where a real adapter
 * (a WMS, a carrier API, NetSuite) plugs in later; payments already have one (./payments, with
 * Stripe). Every write is keyed by the step that made it, so a retried step never double-books, and
 * every compensation is idempotent.
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
  parseCarrierQuote,
  type RateRequest,
  rankStores,
  rateOptions,
  type ShippingConfig,
  type ShippingOption,
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
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { reverseBalanceEntry, voidInvoices } from './billing';
import { voidAuthorizations } from './payments';

const db = (env: Env) => createDb(env.DB);
const simulate = (order: Order) => String(order.meta?.simulate ?? '');

export async function getCustomer(env: Env, id: string | undefined) {
  if (!id) return undefined;
  return db(env).query.customers.findFirst({ where: eq(customers.id, id) });
}

/**
 * The one customer whose name is exactly `name`, ignoring case, spacing and punctuation. The name
 * comes from a model reading a document anyone can write, so a near match or one of several
 * matches attaches nobody: the order then waits for a person to choose the customer.
 */
export async function findCustomerByName(env: Env, name: string) {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const needle = norm(name);
  if (!needle) return undefined;
  const matches = (await db(env).select().from(customers)).filter((c) => norm(c.name) === needle);
  return matches.length === 1 ? matches[0] : undefined;
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
    // The reservation row is written only while the stock is still free, so two orders racing
    // for the last units can't both hold them. The hold applies only if the row exists.
    const row = {
      id: sql`${id}`.as('id'),
      orderId: sql`${order.id}`.as('order_id'),
      sku: sql`${line.sku}`.as('sku'),
      qty: sql`${line.qty}`.as('qty'),
      status: sql`'held'`.as('status'),
      createdAt: sql`${Date.now()}`.as('created_at'),
      locationId: sql`${locationId ?? null}`.as('location_id'),
    };
    const free = locationId
      ? d
          .select(row)
          .from(locationStock)
          .where(
            and(
              eq(locationStock.locationId, locationId),
              eq(locationStock.sku, line.sku),
              sql`${locationStock.stock} - ${locationStock.reserved} >= ${line.qty}`,
            ),
          )
      : d
          .select(row)
          .from(products)
          .where(
            and(
              eq(products.sku, line.sku),
              sql`${products.stock} - ${products.reserved} >= ${line.qty}`,
            ),
          );
    await moveStock(
      env,
      { id, orderId: order.id, sku: line.sku, kind: 'hold', qty: line.qty, locationId },
      d.insert(reservations).select(free).onConflictDoNothing(),
      sql`exists (select 1 from ${reservations} where ${eq(reservations.id, id)})`,
    );
    reservationIds.push(id);
  }
  if (!reservationIds.length) return { reservationIds, short };
  // Lines another order took between the read above and the hold are short after all.
  const got = new Set(
    (
      await d
        .select({ id: reservations.id })
        .from(reservations)
        .where(inArray(reservations.id, reservationIds))
    ).map((r) => r.id),
  );
  for (const [i, line] of lines) {
    const id = idFor(i, line.sku);
    if (reservationIds.includes(id) && !got.has(id)) short.push(line.sku);
  }
  return { reservationIds: reservationIds.filter((id) => got.has(id)), short };
}

/**
 * Moves every held reservation for the order to `status` (released or consumed) and applies it to
 * stock in the same batch. Each row's movement is keyed by the reservation and applies only while
 * the row is the one that made the move, so a cancel racing a rollback, or a release racing a
 * consume, changes stock once. Returns how many reservations this call moved.
 */
async function settleReservations(env: Env, orderId: string, status: 'released' | 'consumed') {
  const d = db(env);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'held')));
  let moved = 0;
  for (const r of held) {
    const kind = status === 'released' ? 'release' : 'consume';
    await moveStock(
      env,
      {
        id: `${kind}_${r.id}`,
        orderId,
        sku: r.sku,
        kind,
        qty: r.qty,
        locationId: r.locationId ?? undefined,
      },
      d
        .update(reservations)
        .set({ status })
        .where(and(eq(reservations.id, r.id), eq(reservations.status, 'held'))),
      sql`exists (select 1 from ${reservations} where ${and(eq(reservations.id, r.id), eq(reservations.status, status))})`,
    );
    const [row] = await d
      .select({ applied: stockMovements.applied })
      .from(stockMovements)
      .where(eq(stockMovements.id, `${kind}_${r.id}`));
    if (row?.applied) moved += 1;
  }
  return moved;
}

/** Compensation: release every held reservation for the order. Idempotent. */
export function releaseInventory(env: Env, orderId: string) {
  return settleReservations(env, orderId, 'released');
}

/** Shipping or handing goods over consumes held stock. */
export async function consumeInventory(env: Env, orderId: string) {
  await settleReservations(env, orderId, 'consumed');
}

/**
 * Compensation for a cancelled shipment: once none of the order's goods are still booked or with
 * the customer, stock its shipments consumed goes back where it came from. Each reservation comes
 * back at most once. Returns how many reservations were restored.
 */
export async function restoreShippedStock(env: Env, orderId: string) {
  const d = db(env);
  const live = await d
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.orderId, orderId),
        inArray(shipments.status, ['label_created', 'ready_for_pickup', 'collected']),
      ),
    )
    .limit(1);
  if (live.length) return 0;
  const consumed = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'consumed')));
  for (const r of consumed)
    await moveStock(
      env,
      {
        id: `unconsume_${r.id}`,
        orderId,
        sku: r.sku,
        kind: 'restock',
        qty: r.qty,
        locationId: r.locationId ?? undefined,
      },
      d
        .update(reservations)
        .set({ status: 'restored' })
        .where(and(eq(reservations.id, r.id), eq(reservations.status, 'consumed'))),
      sql`exists (select 1 from ${reservations} where ${and(eq(reservations.id, r.id), eq(reservations.status, 'restored'))})`,
    );
  return consumed.length;
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
 * of the batch (the reservation row it belongs to); `guard`, checked after it, must hold for the
 * change to apply and be marked applied. A `locationId` moves a store's stock instead of central
 * stock.
 */
async function moveStock(
  env: Env,
  m: {
    id: string;
    orderId: string;
    sku: string;
    kind: 'hold' | 'restock' | 'release' | 'consume';
    qty: number;
    locationId?: string;
  },
  first?: BatchItem<'sqlite'>,
  guard?: SQL,
) {
  const d = db(env);
  const pending = and(
    sql`exists (select 1 from ${stockMovements} where ${and(eq(stockMovements.id, m.id), eq(stockMovements.applied, false))})`,
    guard,
  );
  const record = d
    .insert(stockMovements)
    .values({ ...m, locationId: m.locationId ?? null, createdAt: Date.now() })
    .onConflictDoNothing();
  const apply = m.locationId
    ? d
        .update(locationStock)
        .set(stockChange(m.kind, m.qty, locationStock))
        .where(
          and(eq(locationStock.locationId, m.locationId), eq(locationStock.sku, m.sku), pending),
        )
    : d
        .update(products)
        .set(stockChange(m.kind, m.qty, products))
        .where(and(eq(products.sku, m.sku), pending));
  const mark = d
    .update(stockMovements)
    .set({ applied: true })
    .where(and(eq(stockMovements.id, m.id), guard));
  await (first ? d.batch([first, record, apply, mark]) : d.batch([record, apply, mark]));
}

/** What a movement does to a stock row (central or a store's). */
function stockChange(
  kind: 'hold' | 'restock' | 'release' | 'consume',
  qty: number,
  t: { stock: SQLiteColumn; reserved: SQLiteColumn },
) {
  switch (kind) {
    case 'hold':
      return { reserved: sql`${t.reserved} + ${qty}` };
    case 'restock':
      return { stock: sql`${t.stock} + ${qty}` };
    case 'release':
      return { reserved: sql`max(0, ${t.reserved} - ${qty})` };
    case 'consume':
      return { stock: sql`${t.stock} - ${qty}`, reserved: sql`max(0, ${t.reserved} - ${qty})` };
  }
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
    const ranked = rankStores(
      stores.filter((s) => s.ships),
      shipToPoint(order),
    );
    // One read per source, all at once; the ranking order is kept.
    const [central, ...perStore] = await Promise.all([
      available(env, skus),
      ...ranked.map((store) => available(env, skus, store.id)),
    ]);
    const sources: StockSource[] = [
      { id: null, name: 'Warehouse', free: central! },
      ...ranked.map((store, i) => ({ id: store.id, name: store.name, free: perStore[i]! })),
    ];
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
  const rows = [];
  for (const [i, l] of order.lines.entries()) {
    if (bySku.get(l.sku)?.kind !== 'digital') continue;
    for (let n = 0; n < l.qty; n++) {
      const id = `ent_${order.id}_${stepKey}_${i}_${n}`.replace(/[^\w-]/g, '_');
      const h = Math.abs(hash(id)).toString(36).toUpperCase().padStart(8, '0');
      rows.push({
        id,
        orderId: order.id,
        sku: l.sku,
        code: `${l.sku}-${h.slice(0, 4)}-${h.slice(4, 8)}`,
        status: 'issued',
        createdAt: now,
      });
    }
  }
  // Multi-row inserts in one batch (D1 binds at most 100 values per statement: 6 per row).
  const d = db(env);
  const inserts = chunk(rows, 16).map((part) =>
    d.insert(entitlements).values(part).onConflictDoNothing(),
  );
  if (inserts.length) await d.batch([inserts[0]!, ...inserts.slice(1)]);
  return rows.map((r) => ({ sku: r.sku, code: r.code }));
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
  return db(env)
    .select()
    .from(products)
    .where(sql`${products.stock} - ${products.reserved} <= ${products.reorderPoint}`);
}

/** `items` in runs of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** Checks a ship-to. The mock is the deterministic core validator; a USPS or Loqate call goes here. */
export async function validateAddress(_env: Env, shipTo: unknown) {
  return checkAddress(shipTo);
}

// ── Payments ───────────────────────────────────────────────────────────────

// The gateway (mock or Stripe) lives in ./payments; re-exported for existing callers.
export {
  authorizePayment,
  capturePayment,
  charge,
  paidAmount,
  paySupplier,
  refund,
  voidAuthorizations,
} from './payments';

// ── Customer balances ──────────────────────────────────────────────────────

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

/**
 * Compensation: takes the order's invoices back off the customer's account. Each entry is reversed
 * at most once, by its own ledger row, and not at all once its invoice was paid (settled). Returns
 * how many entries were reversed.
 */
export async function reverseBalance(env: Env, orderId: string) {
  const d = db(env);
  const entries = await d
    .select()
    .from(balanceEntries)
    .where(
      and(
        eq(balanceEntries.orderId, orderId),
        eq(balanceEntries.applied, true),
        sql`${balanceEntries.amount} > 0`,
        sql`${balanceEntries.id} not like 'rev_%'`,
      ),
    );
  let reversed = 0;
  for (const e of entries) {
    const [, , marked] = await d.batch(reverseBalanceEntry(env, e, Date.now()));
    if (marked.length) reversed += 1;
  }
  return reversed;
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
  const [first, ...rest] = [...groups].map(([sellerId, lines]) => {
    const seller = known.get(sellerId);
    const accepted = sellerId === FIRST_PARTY || !!seller?.autoAccept;
    return d
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
  });
  if (first) await d.batch([first, ...rest]);
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
  const [parts, paid] = await Promise.all([
    d
      .select({ part: sellerOrders, pct: sellers.commissionPct })
      .from(sellerOrders)
      .innerJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
      .where(and(eq(sellerOrders.orderId, order.id), eq(sellerOrders.status, 'accepted'))),
    d.select().from(payments).where(eq(payments.orderId, order.id)),
  ]);
  const refunds = paid
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
    out.push(row);
  }
  const [first, ...rest] = out.map((row) => d.insert(payouts).values(row).onConflictDoNothing());
  if (first) await d.batch([first, ...rest]);
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

const CARRIER_TIMEOUT_MS = 5_000;

/** Units that ship: digital lines don't. */
export async function physicalUnits(env: Env, order: Order) {
  const { lines } = await stockedLines(env, order);
  return lines.reduce((n, [, l]) => n + l.qty, 0);
}

/** `SHIPPING_CARRIER_AUTH`: a JSON object of live carrier id → Authorization header value. */
function carrierAuth(env: Env): Record<string, string> {
  try {
    const v = JSON.parse(env.SHIPPING_CARRIER_AUTH ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/**
 * Quotes one live carrier: POSTs `{ itemCount, country, subtotal, currency }` (amounts in the base
 * currency) and reads `{ options: [...] }`. Any failure (https only, 5 s, non-2xx, bad JSON)
 * returns no options, so the caller falls back to the static services.
 */
async function liveQuote(
  carrier: ShippingConfig['liveCarriers'][number],
  req: RateRequest,
  auth: string | undefined,
): Promise<ShippingOption[]> {
  if (!carrier.url.startsWith('https://')) return [];
  try {
    const res = await fetch(carrier.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({
        itemCount: req.itemCount,
        country: req.country ?? null,
        subtotal: req.subtotal,
        currency: BASE_CURRENCY,
      }),
      signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseCarrierQuote(carrier, await res.json());
  } catch {
    return [];
  }
}

/**
 * The shipping options for a request, cheapest first: the live carriers' quotes when any answered,
 * else the static services (a carrier adapter replaces the mock here).
 */
export async function quoteShipping(
  env: Env,
  config: ShippingConfig,
  req: RateRequest,
): Promise<{ options: ShippingOption[]; source: 'live' | 'static' }> {
  const auth = config.liveCarriers.length ? carrierAuth(env) : {};
  const live = (
    await Promise.all(config.liveCarriers.map((c) => liveQuote(c, req, auth[c.id])))
  ).flat();
  return { options: rateOptions(config, req, live), source: live.length ? 'live' : 'static' };
}

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
<p>Subtotal ${cash(order.subtotal)}${order.shipping || order.shippingOption ? ` · Shipping ${cash(order.shipping ?? 0)}` : ''} · Tax ${cash(order.tax)} · <b>Total ${cash(order.total)} ${esc(order.currency)}</b></p>`;
}

/** Undo everything compensable for an order (cancel path; Workflow rollback covers failures). */
export async function compensateOrder(env: Env, orderId: string) {
  const [released, voided, cancelled, sellerOrdersCancelled, payoutsReversed, revoked, invoices] =
    await Promise.all([
      releaseInventory(env, orderId),
      voidAuthorizations(env, orderId),
      cancelOpenShipments(env, orderId),
      cancelSellerOrders(env, orderId),
      reversePayouts(env, orderId),
      revokeEntitlements(env, orderId),
      voidInvoices(env, orderId),
    ]);
  // After the void, so an invoice found paid in Stripe keeps its (settled) account charge.
  const unbilled = await reverseBalance(env, orderId);
  // After the cancel above, so a shipment it cancelled no longer holds the stock.
  const restored = await restoreShippedStock(env, orderId);
  return {
    released,
    voided,
    cancelled,
    restored,
    sellerOrdersCancelled,
    payoutsReversed,
    revoked,
    unbilled,
    invoicesVoided: invoices.voided,
    invoicesPaid: invoices.paid,
  };
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
