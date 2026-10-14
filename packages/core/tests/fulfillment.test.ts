import { describe, expect, it } from 'vitest';
import { allocateLines, distanceKm, rankStores, type StockSource, shipToPoint } from '../src';

const soho = {
  id: 'loc_soho',
  name: 'SoHo',
  postalCode: '10012',
  latitude: 40.7233,
  longitude: -74.003,
};
const mission = {
  id: 'loc_mission',
  name: 'Mission',
  postalCode: '94110',
  latitude: 37.7599,
  longitude: -122.4148,
};
const nowhere = { id: 'loc_a_nowhere', name: 'No coords', postalCode: '' };

describe('nearest store', () => {
  it('reads the ship-to point from an address object only', () => {
    expect(shipToPoint({ meta: { shipTo: '1 Main St' } })).toEqual({});
    expect(
      shipToPoint({
        meta: { shipTo: { postalCode: ' 94103 ', latitude: 37.77, longitude: -122.41 } },
      }),
    ).toEqual({ postalCode: '94103', latitude: 37.77, longitude: -122.41, country: undefined });
  });

  it('measures great-circle distance', () => {
    expect(Math.round(distanceKm(soho, mission))).toBe(4129);
  });

  it('ranks by distance, then postal code, then id', () => {
    const stores = [soho, mission, nowhere];
    expect(rankStores(stores, { latitude: 37.77, longitude: -122.41 }).map((s) => s.id)).toEqual([
      'loc_mission',
      'loc_soho',
      'loc_a_nowhere',
    ]);
    expect(rankStores(stores, { postalCode: '10003' }).map((s) => s.id)).toEqual([
      'loc_soho',
      'loc_mission',
      'loc_a_nowhere',
    ]);
    expect(rankStores(stores, {}).map((s) => s.id)).toEqual([
      'loc_a_nowhere',
      'loc_mission',
      'loc_soho',
    ]);
  });
});

describe('allocateLines', () => {
  const src = (id: string | null, stock: Record<string, number>): StockSource => ({
    id,
    name: id ?? 'Warehouse',
    free: new Map(Object.entries(stock)),
  });
  const central = src(null, { MON: 10, TEE: 0 });
  const near = src('near', { TEE: 3 });
  const far = src('far', { TEE: 30, MON: 1 });

  it('ships the whole order from the first source that has everything', () => {
    const r = allocateLines([{ index: 0, sku: 'TEE', qty: 2 }], [central, near, far]);
    expect(r).toEqual({ kind: 'whole', source: near });
  });

  it('splits by line when no source has everything, nearest first', () => {
    const r = allocateLines(
      [
        { index: 0, sku: 'MON', qty: 4 },
        { index: 1, sku: 'TEE', qty: 2 },
        { index: 2, sku: 'TEE', qty: 2 },
      ],
      [central, near, far],
    );
    expect(r.kind).toBe('split');
    if (r.kind !== 'split') return;
    // The second tee line can't count the units the first one took from `near`.
    expect([...r.lines].map(([i, s]) => [i, s.id])).toEqual([
      [0, null],
      [1, 'near'],
      [2, 'far'],
    ]);
  });

  it('reports lines no single source can ship', () => {
    expect(allocateLines([{ index: 0, sku: 'TEE', qty: 40 }], [central, near, far])).toEqual({
      kind: 'unavailable',
      short: ['TEE'],
    });
  });
});
