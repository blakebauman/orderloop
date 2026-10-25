/**
 * The Commerce page's back office, each list searched, counted and paged in D1, so the page stays
 * the same size however large the catalog, customer list or price book grows. A search (`q`)
 * narrows every list here, on the server. New order and the carts still read everything through
 * `commerceData` (`orders.server.ts`), for their pickers.
 */

import {
  contains,
  contractPrices,
  customers,
  locationStock,
  locations,
  priceRules,
  priceSources,
  products,
  sellers,
} from '@orderloop/db';
import { and, eq, getTableColumns, or, type SQL, sql } from 'drizzle-orm';
import {
  GROUP_SIZE,
  LIST_SIZE,
  lastPage,
  type Paged,
  pageOf,
  pricesKey,
  storeKey,
} from './commerce-pages';
import { db } from './env.server';
import { currencies } from './orders.server';

/** One list's page: counted first, so a page past the end shows the last one. */
async function paged<T>(
  total: () => Promise<{ n: number }[]>,
  rows: (limit: number, offset: number) => Promise<T[]>,
  asked: number,
  size: number,
): Promise<Paged<T>> {
  const n = (await total())[0]?.n ?? 0;
  const page = Math.min(asked, lastPage(n, size));
  return { rows: n ? await rows(size, (page - 1) * size) : [], total: n, page, size };
}

const n = sql<number>`count(*)`;

export async function commercePage(params: URLSearchParams) {
  // "#idz7qp" is how the app writes an order; a search for one shouldn't hide the rest.
  const q = params.get('q')?.trim().replace(/^#/, '') ?? '';
  const any = (...conds: SQL[]) => (q ? or(...conds) : undefined);

  const inventoryWhere = any(contains(products.name, q), contains(products.sku, q));
  const customerWhere = any(contains(customers.name, q), contains(customers.id, q));
  const sellerWhere = any(
    contains(sellers.name, q),
    contains(sellers.email, q),
    contains(sellers.id, q),
  );

  const [inventory, customerList, sellerList, stores, sources, rates] = await Promise.all([
    paged(
      () => db().select({ n }).from(products).where(inventoryWhere),
      (limit, offset) =>
        db()
          .select({
            ...getTableColumns(products),
            // What the stores hold, so an item out in the warehouse isn't read as out everywhere.
            // `products.sku` written out: unqualified, it would be the subquery's own column.
            inStores: sql<number>`(select coalesce(sum(ls.stock - ls.reserved), 0) from location_stock ls where ls.sku = products.sku)`,
          })
          .from(products)
          .where(inventoryWhere)
          .orderBy(products.sku)
          .limit(limit)
          .offset(offset),
      pageOf(params, 'inventory'),
      LIST_SIZE,
    ),
    paged(
      () => db().select({ n }).from(customers).where(customerWhere),
      (limit, offset) =>
        db()
          .select()
          .from(customers)
          .where(customerWhere)
          .orderBy(customers.name, customers.id)
          .limit(limit)
          .offset(offset),
      pageOf(params, 'customers'),
      LIST_SIZE,
    ),
    paged(
      () => db().select({ n }).from(sellers).where(sellerWhere),
      (limit, offset) =>
        db()
          .select()
          .from(sellers)
          .where(sellerWhere)
          .orderBy(sellers.name, sellers.id)
          .limit(limit)
          .offset(offset),
      pageOf(params, 'sellers'),
      LIST_SIZE,
    ),
    db().select().from(locations).orderBy(locations.name),
    db().select().from(priceSources).orderBy(priceSources.priority),
    currencies(),
  ]);

  const [storeStock, prices] = await Promise.all([
    Promise.all(
      stores.map((l) => {
        // A search for the store itself shows all it holds; otherwise only the matching items.
        const where = and(
          eq(locationStock.locationId, l.id),
          q && !l.name.toLowerCase().includes(q.toLowerCase())
            ? or(contains(locationStock.sku, q), contains(products.name, q))
            : undefined,
        );
        return paged(
          () =>
            db()
              .select({ n })
              .from(locationStock)
              .leftJoin(products, eq(products.sku, locationStock.sku))
              .where(where),
          (limit, offset) =>
            db()
              .select({
                sku: locationStock.sku,
                name: products.name,
                stock: locationStock.stock,
                reserved: locationStock.reserved,
              })
              .from(locationStock)
              .leftJoin(products, eq(products.sku, locationStock.sku))
              .where(where)
              .orderBy(locationStock.sku)
              .limit(limit)
              .offset(offset),
          pageOf(params, storeKey(l.id)),
          GROUP_SIZE,
        );
      }),
    ),
    Promise.all(sources.map((s) => sourceEntries(s.id, q, pageOf(params, pricesKey(s.id))))),
  ]);

  return {
    q,
    inventory,
    customers: customerList,
    sellers: sellerList,
    stores: stores.map((l, i) => ({ ...l, stock: storeStock[i]! })),
    pricing: { sources: sources.map((s, i) => ({ ...s, entries: prices[i]! })), rates },
  };
}

export type CommercePage = Awaited<ReturnType<typeof commercePage>>;

/** One pricing source's entries: contract prices for `contract`, its rules for any other. */
function sourceEntries(sourceId: string, q: string, page: number) {
  if (sourceId === 'contract') {
    const where = q
      ? or(contains(contractPrices.sku, q), contains(products.name, q), contains(customers.name, q))
      : undefined;
    const from = () =>
      db()
        .select({
          key: sql<string>`${contractPrices.customerId} || '-' || ${contractPrices.sku}`,
          name: sql<string>`coalesce(${customers.name}, ${contractPrices.customerId})`,
          sku: contractPrices.sku,
          productName: products.name,
          customerTier: sql<string | null>`null`,
          customerName: sql<string | null>`null`,
          minQty: sql<number | null>`null`,
          price: contractPrices.price,
          discountPct: sql<number | null>`null`,
        })
        .from(contractPrices)
        .leftJoin(customers, eq(customers.id, contractPrices.customerId))
        .leftJoin(products, eq(products.sku, contractPrices.sku));
    return paged(
      () =>
        db()
          .select({ n })
          .from(contractPrices)
          .leftJoin(customers, eq(customers.id, contractPrices.customerId))
          .leftJoin(products, eq(products.sku, contractPrices.sku))
          .where(where),
      (limit, offset) =>
        from().where(where).orderBy(customers.name, contractPrices.sku).limit(limit).offset(offset),
      page,
      GROUP_SIZE,
    );
  }
  const where = and(
    eq(priceRules.sourceId, sourceId),
    q
      ? or(
          contains(priceRules.name, q),
          contains(priceRules.sku, q),
          contains(products.name, q),
          contains(customers.name, q),
        )
      : undefined,
  );
  return paged(
    () =>
      db()
        .select({ n })
        .from(priceRules)
        .leftJoin(products, eq(products.sku, priceRules.sku))
        .leftJoin(customers, eq(customers.id, priceRules.customerId))
        .where(where),
    (limit, offset) =>
      db()
        .select({
          key: priceRules.id,
          name: priceRules.name,
          sku: priceRules.sku,
          productName: products.name,
          customerTier: priceRules.customerTier,
          customerName: sql<string | null>`coalesce(${customers.name}, ${priceRules.customerId})`,
          minQty: priceRules.minQty,
          price: priceRules.price,
          discountPct: priceRules.discountPct,
        })
        .from(priceRules)
        .leftJoin(products, eq(products.sku, priceRules.sku))
        .leftJoin(customers, eq(customers.id, priceRules.customerId))
        .where(where)
        .orderBy(priceRules.sku, priceRules.minQty, priceRules.id)
        .limit(limit)
        .offset(offset),
    page,
    GROUP_SIZE,
  );
}
