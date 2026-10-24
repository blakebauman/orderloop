/**
 * Mock commerce connectors over the D1 back office and R2. Each is the seam where a real adapter
 * (a WMS, a carrier API, NetSuite) plugs in later; payments already have one (./payments, with
 * Stripe). Every write is keyed by the step that made it, so a retried step never double-books, and
 * every compensation is idempotent.
 *
 * Failure simulation for demos and tests: set `order.meta.simulate` to one of
 * "payment_decline", "charge_fail", "out_of_stock", "three_way_mismatch".
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  allocateLines,
  BASE_CURRENCY,
  checkAddress,
  type LabelPackage,
  money,
  newId,
  type Order,
  type OrderLine,
  type ParcelLine,
  PROMOTION_KINDS,
  PROVIDER_MAX_RATE,
  type PriceRule,
  type PriceSource,
  type PriceSourceKind,
  type Promotion,
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
  promotionRedemptions,
  promotions,
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
import { provide } from './providers';

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
  const matches = (
    await db(env).select({ id: customers.id, name: customers.name }).from(customers)
  ).filter((c) => norm(c.name) === needle);
  return matches.length === 1 ? matches[0] : undefined;
}

export async function getProducts(env: Env, skus?: string[]) {
  const q = db(env).select().from(products);
  return skus ? q.where(inArray(products.sku, skus)) : q;
}

/** The promotions with these codes, as the discount node reads them. */
export async function promotionsByCode(env: Env, codes: string[]): Promise<Promotion[]> {
  if (!codes.length) return [];
  const rows = await db(env).select().from(promotions).where(inArray(promotions.code, codes));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    kind: (PROMOTION_KINDS as readonly string[]).includes(r.kind)
      ? (r.kind as Promotion['kind'])
      : 'pct',
    value: r.value,
    currency: r.currency,
    minSubtotal: r.minSubtotal,
    skus: r.skus ? (JSON.parse(r.skus) as string[]) : null,
    customerId: r.customerId,
    validFrom: r.validFrom,
    validTo: r.validTo,
    maxRedemptions: r.maxRedemptions,
    perCustomerLimit: r.perCustomerLimit,
    status: r.status === 'paused' ? 'paused' : 'active',
  }));
}

/** Redemptions of a promotion by orders other than `orderId`: all, and the customer's. */
export async function redemptionsOf(
  env: Env,
  promotionId: string,
  orderId: string,
  customerId: string | undefined,
) {
  const row = await db(env)
    .select({
      total: sql<number>`count(*)`,
      byCustomer: sql<number>`coalesce(sum(case when ${promotionRedemptions.customerId} = ${customerId ?? null} then 1 else 0 end), 0)`,
    })
    .from(promotionRedemptions)
    .where(
      and(
        eq(promotionRedemptions.promotionId, promotionId),
        sql`${promotionRedemptions.orderId} <> ${orderId}`,
      ),
    )
    .get();
  return { total: row?.total ?? 0, byCustomer: row?.byCustomer ?? 0 };
}

/**
 * Records that `orderId` redeemed the promotion, once (keyed by promotion and order), and only
 * while it is under its limit: the count and the insert are one statement, so two orders racing
 * for the last redemption can't both have it. True when the order holds the redemption.
 */
export async function redeemPromotion(
  env: Env,
  r: {
    promotion: Pick<Promotion, 'id' | 'maxRedemptions'>;
    orderId: string;
    customerId: string | undefined;
    amount: number;
    stepKey: string;
  },
): Promise<boolean> {
  const max = r.promotion.maxRedemptions ?? Number.MAX_SAFE_INTEGER;
  await env.DB.prepare(
    `INSERT INTO promotion_redemptions (promotion_id, order_id, customer_id, amount, step_key, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE (SELECT count(*) FROM promotion_redemptions WHERE promotion_id = ?1 AND order_id <> ?2) < ?7
     ON CONFLICT (promotion_id, order_id) DO NOTHING`,
  )
    .bind(r.promotion.id, r.orderId, r.customerId ?? null, r.amount, r.stepKey, Date.now(), max)
    .run();
  const held = await db(env)
    .select({ id: promotionRedemptions.promotionId })
    .from(promotionRedemptions)
    .where(
      and(
        eq(promotionRedemptions.promotionId, r.promotion.id),
        eq(promotionRedemptions.orderId, r.orderId),
      ),
    )
    .get();
  return !!held;
}

/** Gives back what an order redeemed (a failed or cancelled order); safe to repeat. */
export async function releaseRedemptions(env: Env, orderId: string): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM promotion_redemptions WHERE order_id = ?')
    .bind(orderId)
    .run();
  return r.meta.changes ?? 0;
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
  const locs = [...new Set(lines.map(([, l]) => locationOf(l)))];
  const free = new Map(
    await Promise.all(
      locs.map(
        async (loc) =>
          [
            loc,
            await available(
              env,
              lines.filter(([, l]) => locationOf(l) === loc).map(([, l]) => l.sku),
              loc,
            ),
          ] as const,
      ),
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
  const moves: StockMove[] = [];
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
    moves.push({
      m: { id, orderId: order.id, sku: line.sku, kind: 'hold', qty: line.qty, locationId },
      first: d.insert(reservations).select(free).onConflictDoNothing(),
      guard: sql`exists (select 1 from ${reservations} where ${eq(reservations.id, id)})`,
    });
    reservationIds.push(id);
  }
  if (!reservationIds.length) return { reservationIds, short };
  // One batch (one transaction) for every line; each line's statements keep their own guard.
  await moveStocks(env, moves);
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
  if (!held.length) return 0;
  const kind = status === 'released' ? 'release' : 'consume';
  const ids = held.map((r) => `${kind}_${r.id}`);
  await moveStocks(
    env,
    held.map((r, i) => ({
      m: {
        id: ids[i]!,
        orderId,
        sku: r.sku,
        kind,
        qty: r.qty,
        locationId: r.locationId ?? undefined,
      },
      first: d
        .update(reservations)
        .set({ status })
        .where(and(eq(reservations.id, r.id), eq(reservations.status, 'held'))),
      guard: sql`exists (select 1 from ${reservations} where ${and(eq(reservations.id, r.id), eq(reservations.status, status))})`,
    })),
  );
  const applied = await d
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(and(inArray(stockMovements.id, ids), eq(stockMovements.applied, true)));
  return applied.length;
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
  await moveStocks(
    env,
    consumed.map((r) => ({
      m: {
        id: `unconsume_${r.id}`,
        orderId,
        sku: r.sku,
        kind: 'restock',
        qty: r.qty,
        locationId: r.locationId ?? undefined,
      },
      first: d
        .update(reservations)
        .set({ status: 'restored' })
        .where(and(eq(reservations.id, r.id), eq(reservations.status, 'consumed'))),
      guard: sql`exists (select 1 from ${reservations} where ${and(eq(reservations.id, r.id), eq(reservations.status, 'restored'))})`,
    })),
  );
  return consumed.length;
}

/** Adds returned or received stock to central stock, once per step and line. */
export async function restock(env: Env, orderId: string, stepKey: string, lines: StockLine[]) {
  await moveStocks(
    env,
    lines.map((l, i) => ({
      m: {
        id: `stk_${orderId}_${stepKey}_${i}_${l.sku}`.replace(/[^\w-]/g, '_'),
        orderId,
        sku: l.sku,
        kind: 'restock',
        qty: l.qty,
      },
    })),
  );
}

type StockMove = {
  m: {
    id: string;
    orderId: string;
    sku: string;
    kind: 'hold' | 'restock' | 'release' | 'consume';
    qty: number;
    locationId?: string;
  };
  first?: BatchItem<'sqlite'>;
  guard?: SQL;
};

/**
 * Records inventory changes in the ledger and applies them, in one batch: one D1 transaction,
 * whose statements run in order. Each change's statements are those of `moveStatements`, so a
 * line's guard sees the lines before it exactly as it would in a batch of its own.
 */
async function moveStocks(env: Env, moves: StockMove[]) {
  if (!moves.length) return;
  const [head, ...rest] = moves.flatMap((x) => moveStatements(env, x));
  await db(env).batch([head!, ...rest]);
}

/**
 * One inventory change's statements: record it in the ledger and apply it, only if it hasn't been
 * applied yet. They run in one transaction, so a crash can't leave the ledger and the stock row
 * disagreeing, and a retry with the same id changes nothing. `first` runs before them (the
 * reservation row it belongs to); `guard`, checked after it, must hold for the change to apply and
 * be marked applied. A `locationId` moves a store's stock instead of central stock.
 */
function moveStatements(env: Env, { m, first, guard }: StockMove): BatchItem<'sqlite'>[] {
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
  return first ? [first, record, apply, mark] : [record, apply, mark];
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
  if (!entries.length) return 0;
  // One batch for every entry; each entry's three statements keep their own guards.
  const now = Date.now();
  const [head, ...rest] = entries.flatMap((e) => reverseBalanceEntry(env, e, now));
  const results = await d.batch([head!, ...rest]);
  // Every third result is an entry's `mark`, which returns the row only when it reversed it.
  return results.filter((r, i) => i % 3 === 2 && (r as unknown[]).length).length;
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

/** The lines that ship (digital lines don't), with their products' per-unit weight and size. */
export async function physicalLines(env: Env, order: Order): Promise<ParcelLine[]> {
  const { bySku, lines } = await stockedLines(env, order);
  return lines.map(([, l]) => {
    const p = bySku.get(l.sku);
    return {
      qty: l.qty,
      weightKg: p?.weightKg,
      lengthCm: p?.lengthCm,
      widthCm: p?.widthCm,
      heightCm: p?.heightCm,
    };
  });
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
 * currency), plus `billableKg` when the basis weighs units, and reads `{ options: [...] }`. Any failure (https only, 5 s, non-2xx, bad JSON)
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
        ...(req.billableKg !== undefined ? { billableKg: req.billableKg } : {}),
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
 * The shipping options for a request, cheapest first: the provider's quote when the node names one
 * and it answers with options, else the live carriers' quotes when any answered, else the static
 * services. A provider's options are checked as a live carrier's are, and its ids carry its id.
 */
export async function quoteShipping(
  env: Env,
  config: ShippingConfig,
  req: RateRequest,
  provider?: { id: string; quote: () => Promise<{ options: unknown[] }> },
): Promise<{
  options: ShippingOption[];
  source: 'provider' | 'live' | 'static';
  /** Why the provider's quote wasn't used, when the node named one. */
  providerError?: string;
}> {
  let providerError: string | undefined;
  if (provider) {
    try {
      const quoted = parseCarrierQuote(
        { id: provider.id, carrier: provider.id, url: '' },
        await provider.quote(),
      ).filter((o) => o.amount <= PROVIDER_MAX_RATE);
      if (quoted.length) return { options: rateOptions(config, req, quoted), source: 'provider' };
      providerError = 'offered no usable options';
    } catch (err) {
      // As with a live carrier: rates fall back rather than fail the order, and the node says so.
      console.warn(`shipping rates from ${provider.id}`, err);
      providerError = err instanceof Error ? err.message : String(err);
    }
  }
  const auth = config.liveCarriers.length ? carrierAuth(env) : {};
  const live = (
    await Promise.all(config.liveCarriers.map((c) => liveQuote(c, req, auth[c.id])))
  ).flat();
  return {
    options: rateOptions(config, req, live),
    source: live.length ? 'live' : 'static',
    ...(providerError ? { providerError } : {}),
  };
}

/** A node's Provider, when it names a plugin: who labels the shipment, and the node asking. */
export type LabelProvider = { id: string; nodeId: string; config: Record<string, unknown> };

type Label = { ref: string; id: string; tracking: string; carrier?: string };

/**
 * Asks the provider for a label per package that has goods in it (none at all: no call). A label
 * for a package it wasn't asked about is voided at once; a package it returns no label for fails
 * the node for good, after voiding what it did return. A label that can't be voided is kept as a
 * `void_failed` shipment, retried by `retryLabelVoids`, so nothing stays labelled unrecorded.
 */
async function providerLabels(
  env: Env,
  by: LabelProvider,
  order: Order,
  stepKey: string,
  kind: 'shipment' | 'return',
  carrier: string,
  packages: LabelPackage[],
): Promise<Map<string, Label>> {
  const asked = packages
    .map((p) => ({ ...p, lines: p.lines.filter((l) => l.qty > 0) }))
    .filter((p) => p.lines.length);
  if (!asked.length) return new Map();
  const r = await provide(env, by.id, {
    surface: 'shipping.labels',
    op: 'create',
    nodeId: by.nodeId,
    stepKey,
    orderId: order.id,
    config: by.config,
    order,
    input: { kind, carrier, packages: asked },
  });
  const refs = new Set(asked.map((p) => p.ref));
  const byRef = new Map(r.labels.filter((l) => refs.has(l.ref)).map((l) => [l.ref, l]));
  const missing = asked.filter((p) => !byRef.has(p.ref)).map((p) => p.ref);
  const extra = r.labels.filter((l) => !refs.has(l.ref) || byRef.get(l.ref) !== l);
  const unwanted = missing.length ? r.labels : extra;
  if (unwanted.length)
    await voidOrKeep(
      env,
      by.id,
      order.id,
      stepKey,
      unwanted.map((l) => ({ row: `void_${by.id}_${l.id}`.replace(/[^\w-]/g, '_'), ...l })),
    );
  if (missing.length)
    throw new NonRetryableError(
      `Shipping labels provider “${by.id}” returned no label for ${missing.join(', ')}`,
    );
  return byRef;
}

async function voidLabels(
  env: Env,
  providerId: string,
  orderId: string,
  stepKey: string,
  labels: { ref: string; id: string }[],
) {
  if (!labels.length) return;
  await provide(env, providerId, {
    surface: 'shipping.labels',
    op: 'void',
    nodeId: stepKey.split('#')[0] ?? stepKey,
    stepKey,
    orderId,
    config: {},
    input: { labels: labels.map(({ ref, id }) => ({ ref, id })) },
  });
}

type ToVoid = { row: string; ref: string; id: string; tracking?: string; carrier?: string };

/**
 * Voids labels at their provider and marks their shipments cancelled. Those it can't void are kept
 * (or recorded) as `void_failed` shipments, never `cancelled`, for `retryLabelVoids` to try again
 * and `pluginUsage` to report. Returns how many failed.
 */
async function voidOrKeep(
  env: Env,
  provider: string,
  orderId: string,
  stepKey: string,
  labels: ToVoid[],
): Promise<number> {
  if (!labels.length) return 0;
  let status: 'cancelled' | 'void_failed' = 'cancelled';
  try {
    await voidLabels(env, provider, orderId, stepKey, labels);
  } catch (err) {
    console.error(`voiding ${provider} labels for ${orderId}`, err);
    status = 'void_failed';
  }
  for (const l of labels)
    await db(env)
      .insert(shipments)
      .values({
        id: l.row,
        orderId,
        carrier: l.carrier ?? provider,
        tracking: l.tracking ?? l.id,
        status,
        createdAt: Date.now(),
        provider,
        externalId: l.id,
      })
      .onConflictDoUpdate({ target: shipments.id, set: { status } });
  return status === 'void_failed' ? labels.length : 0;
}

/**
 * Books one shipment per location the physical lines ship from (one, unless routing split the
 * order), then consumes the held stock. The first shipment keeps the step's id, so a single-source
 * order books exactly what it always did; the groups come from the order, so a retry books the same.
 * With a provider, each package's label (tracking, carrier) is the provider's, and the row records
 * which provider made it and its id for the label, to void it on a rollback or a cancel.
 */
export async function createShipment(
  env: Env,
  order: Order,
  stepKey: string,
  carrier: string,
  by?: LabelProvider,
) {
  const base = `shp_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const { lines } = await stockedLines(env, order);
  const locationOf = (l: OrderLine) => l.locationId ?? order.fulfillment?.locationId ?? null;
  const from = [...new Set(lines.map(([, l]) => locationOf(l)))].sort((a, b) =>
    (a ?? '').localeCompare(b ?? ''),
  );
  const packages: LabelPackage[] = (from.length ? from : [null]).map((locationId, n) => ({
    ref: n === 0 ? base : `${base}_${n + 1}`,
    locationId,
    lines: lines
      .filter(([, l]) => locationOf(l) === locationId)
      .map(([, l]) => ({ sku: l.sku, qty: l.qty })),
  }));
  const labels = by
    ? await providerLabels(env, by, order, stepKey, 'shipment', carrier, packages)
    : null;
  const out = [];
  for (const p of packages) {
    const label = labels?.get(p.ref);
    const tracking =
      label?.tracking ??
      `${carrier.toUpperCase()}${Math.abs(hash(p.ref)).toString().padStart(10, '0').slice(0, 10)}`;
    await db(env)
      .insert(shipments)
      .values({
        id: p.ref,
        orderId: order.id,
        carrier: label?.carrier ?? carrier,
        tracking,
        status: 'label_created',
        createdAt: Date.now(),
        provider: label ? by!.id : null,
        externalId: label?.id ?? null,
      })
      .onConflictDoNothing();
    out.push({ shipmentId: p.ref, tracking, locationId: p.locationId });
  }
  await consumeInventory(env, order.id);
  return {
    shipmentId: out[0]!.shipmentId,
    carrier: labels?.get(base)?.carrier ?? carrier,
    tracking: out[0]!.tracking,
    shipments: out,
    ...(labels?.size ? { provider: by!.id } : {}),
  };
}

/** A prepaid return label. Stock comes back with `restock` once the goods arrive. */
export async function createReturnLabel(
  env: Env,
  order: Order,
  stepKey: string,
  carrier: string,
  by?: LabelProvider,
) {
  const id = `rma_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  let label: Label | undefined;
  if (by) {
    const { lines } = await stockedLines(env, order);
    const pkg = {
      ref: id,
      locationId: null,
      lines: lines.map(([, l]) => ({ sku: l.sku, qty: l.qty })),
    };
    label = (await providerLabels(env, by, order, stepKey, 'return', carrier, [pkg])).get(id);
  }
  const tracking =
    label?.tracking ??
    `${carrier.toUpperCase()}R${Math.abs(hash(id)).toString().padStart(9, '0').slice(0, 9)}`;
  await db(env)
    .insert(shipments)
    .values({
      id,
      orderId: order.id,
      carrier: label?.carrier ?? carrier,
      tracking,
      status: 'return_label',
      createdAt: Date.now(),
      provider: label ? by!.id : null,
      externalId: label?.id ?? null,
    })
    .onConflictDoNothing();
  return {
    rmaId: id,
    carrier: label?.carrier ?? carrier,
    tracking,
    ...(label ? { provider: by!.id } : {}),
  };
}

/** The order's provider-made shipments in these statuses (or with these ids), by provider. */
async function providerShipments(
  env: Env,
  where: { orderId: string; statuses: string[] } | { ids: string[] },
) {
  const rows = await db(env)
    .select()
    .from(shipments)
    .where(
      and(
        'ids' in where
          ? inArray(shipments.id, where.ids)
          : and(eq(shipments.orderId, where.orderId), inArray(shipments.status, where.statuses)),
        sql`${shipments.provider} IS NOT NULL AND ${shipments.externalId} IS NOT NULL`,
      ),
    );
  return groupBy(
    rows.filter((r) => r.status !== 'cancelled'),
    (r) => r.provider!,
  );
}

const toVoid = (r: typeof shipments.$inferSelect): ToVoid => ({
  row: r.id,
  ref: r.id,
  id: r.externalId!,
  tracking: r.tracking,
  carrier: r.carrier,
});

/**
 * Rollback of a ship step: voids its provider labels at the provider. Never throws, so the saga's
 * earlier compensations (the payment void, the stock release) still run; a label that can't be
 * voided is kept as `void_failed` and counted. The caller cancels the rest.
 */
export async function voidShipmentLabels(
  env: Env,
  orderId: string,
  stepKey: string,
  ids: string[],
) {
  let voided = 0;
  let failed = 0;
  if (!ids.length) return { voided, failed, kept: new Set<string>() };
  const kept = new Set<string>();
  for (const [provider, group] of await providerShipments(env, { ids })) {
    const n = await voidOrKeep(env, provider, orderId, stepKey, group.map(toVoid));
    if (n) for (const r of group) kept.add(r.id);
    failed += n;
    voided += group.length - n;
  }
  return { voided, failed, kept };
}

/**
 * On a cancel: voids the order's open provider labels (shipments and return labels) before the
 * rest are cancelled here. One a provider can't void is kept as `void_failed` and counted, and the
 * cancel goes on.
 */
async function voidOpenLabels(env: Env, orderId: string) {
  let voided = 0;
  let failed = 0;
  const open = { orderId, statuses: ['label_created', 'ready_for_pickup', 'return_label'] };
  for (const [provider, group] of await providerShipments(env, open)) {
    const n = await voidOrKeep(env, provider, orderId, 'cancel', group.map(toVoid));
    failed += n;
    voided += group.length - n;
  }
  return { voided, failed };
}

/**
 * The daily retry of labels a provider couldn't void (`void_failed`): voided now, they become
 * `cancelled`; still failing, they stay as they are (and keep the plugin in `pluginUsage`).
 */
export async function retryLabelVoids(env: Env, limit = 200) {
  const rows = await db(env)
    .select()
    .from(shipments)
    .where(eq(shipments.status, 'void_failed'))
    .limit(limit);
  let voided = 0;
  for (const [provider, group] of groupBy(rows, (r) => r.provider ?? '')) {
    if (!provider) continue;
    for (const [orderId, mine] of groupBy(group, (r) => r.orderId))
      voided += mine.length - (await voidOrKeep(env, provider, orderId, 'retry', mine.map(toVoid)));
  }
  return { tried: rows.length, voided };
}

function groupBy<T>(xs: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
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
  // First, so a label a provider made is voided there before its shipment reads as cancelled.
  const labels = await voidOpenLabels(env, orderId);
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
    // Shipments voided at their provider were cancelled with the void.
    cancelled: cancelled + labels.voided,
    restored,
    sellerOrdersCancelled,
    payoutsReversed,
    revoked,
    unbilled,
    invoicesVoided: invoices.voided,
    invoicesPaid: invoices.paid,
    labelsNotVoided: labels.failed,
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
