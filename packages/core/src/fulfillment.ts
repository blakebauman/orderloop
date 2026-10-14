/**
 * Where shipped goods come from, kept pure so it is unit tested here: which stores are nearest the
 * ship-to address, and which location each line ships from. The engine's `routeFulfillment`
 * connector reads stock and stores and applies the result.
 */

import type { Order } from './types';

export type GeoPoint = { latitude: number; longitude: number };

/** What routing knows about where an order ships to. */
export type ShipToPoint = Partial<GeoPoint> & { postalCode?: string; country?: string };

/** A store as routing sees it. */
export type StoreSite = {
  id: string;
  name: string;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

/** The order's ship-to coordinates and postal code, from `meta.shipTo` when it is an object. */
export function shipToPoint(order: Pick<Order, 'meta'>): ShipToPoint {
  const v = order.meta?.shipTo;
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  return {
    latitude: num(o.latitude),
    longitude: num(o.longitude),
    postalCode: str(o.postalCode),
    country: str(o.country),
  };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const point = (p: { latitude?: number | null; longitude?: number | null }): GeoPoint | null =>
  typeof p.latitude === 'number' && typeof p.longitude === 'number'
    ? { latitude: p.latitude, longitude: p.longitude }
    : null;

/** Shared leading characters of two postal codes, ignoring spaces and case. */
function sharedPrefix(a: string, b: string): number {
  const x = a.replace(/\s/g, '').toUpperCase();
  const y = b.replace(/\s/g, '').toUpperCase();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Stores nearest first. With coordinates on both sides, by great-circle distance (stores without
 * coordinates go after those with). Otherwise by postal code: the longest shared prefix, then the
 * smallest numeric difference. Ties, and orders with no ship-to, keep id order.
 */
export function rankStores<S extends StoreSite>(stores: S[], to: ShipToPoint): S[] {
  const byId = [...stores].sort((a, b) => a.id.localeCompare(b.id));
  const target = point(to);
  if (target) {
    const km = (s: S) => {
      const p = point(s);
      return p ? distanceKm(target, p) : Number.POSITIVE_INFINITY;
    };
    return byId.sort((a, b) => km(a) - km(b));
  }
  const code = to.postalCode;
  if (!code) return byId;
  const digits = Number(code.replace(/\D/g, '')) || 0;
  const key = (s: S) => {
    const c = s.postalCode ?? '';
    return {
      shared: c ? sharedPrefix(code, c) : -1,
      gap: c ? Math.abs((Number(c.replace(/\D/g, '')) || 0) - digits) : Number.POSITIVE_INFINITY,
    };
  };
  return byId.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return y.shared - x.shared || x.gap - y.gap;
  });
}

/** A place stock can ship from: central stock (`id: null`) or a store. */
export type StockSource = { id: string | null; name: string; free: Map<string, number> };

export type Allocation =
  /** One source ships every line. */
  | { kind: 'whole'; source: StockSource }
  /** Each line ships from the first source holding all of it; `lines` maps line index → source. */
  | { kind: 'split'; lines: Map<number, StockSource> }
  | { kind: 'unavailable'; short: string[] };

/**
 * Picks where the physical lines ship from. `sources` are in preference order (central stock, then
 * stores nearest first). The first source holding every line ships the whole order; otherwise each
 * line goes to the first source holding its full quantity. A line is never split across sources.
 */
export function allocateLines(
  lines: { index: number; sku: string; qty: number }[],
  sources: StockSource[],
): Allocation {
  const covers = (s: StockSource) => lines.every((l) => (s.free.get(l.sku) ?? 0) >= l.qty);
  const whole = sources.find(covers);
  if (whole) return { kind: 'whole', source: whole };
  // Track what earlier lines took, so two lines of one SKU don't both count the same units.
  const left = new Map(sources.map((s) => [s, new Map(s.free)]));
  const out = new Map<number, StockSource>();
  const short: string[] = [];
  for (const l of lines) {
    const from = sources.find((s) => (left.get(s)!.get(l.sku) ?? 0) >= l.qty);
    if (!from) {
      short.push(l.sku);
      continue;
    }
    left.get(from)!.set(l.sku, (left.get(from)!.get(l.sku) ?? 0) - l.qty);
    out.set(l.index, from);
  }
  return short.length ? { kind: 'unavailable', short } : { kind: 'split', lines: out };
}
