import { describe, expect, it } from 'vitest';
import {
  mergeTimeline,
  type StartOrderInput,
  startFingerprint,
  TIMELINE_BROADCAST,
  TIMELINE_CAP,
} from '../src/api';
import type { OrderInput, TimelineEntry } from '../src/types';

const input: OrderInput = {
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  lines: [{ sku: 'WID-100', qty: 50 }],
  meta: { po: 'PO-1' },
};
const req: StartOrderInput = { flowId: 'tpl-b2b-order', input };
const withLines = (lines: OrderInput['lines']): StartOrderInput => ({
  ...req,
  input: { ...input, lines },
});

describe('startFingerprint', () => {
  it('ignores property order but not values', async () => {
    const fp = await startFingerprint(req);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      input: {
        meta: { po: 'PO-1' },
        lines: [{ qty: 50, sku: 'WID-100' }],
        currency: 'USD',
        channel: 'api',
        model: 'b2b',
      } as OrderInput,
      flowId: 'tpl-b2b-order',
    };
    expect(await startFingerprint(reordered)).toBe(fp);
    expect(await startFingerprint({ ...req, version: 2 })).not.toBe(fp);
    expect(await startFingerprint({ ...req, vars: { rush: true } })).not.toBe(fp);
    expect(await startFingerprint(withLines([{ sku: 'WID-100', qty: 51 }]))).not.toBe(fp);
  });

  it('keeps array order significant', async () => {
    const ab = withLines([
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 1 },
    ]);
    const ba = withLines([
      { sku: 'B', qty: 1 },
      { sku: 'A', qty: 1 },
    ]);
    expect(await startFingerprint(ab)).not.toBe(await startFingerprint(ba));
  });
});

describe('mergeTimeline', () => {
  const entry = (i: number, key?: string): TimelineEntry => ({
    at: i,
    kind: 'node',
    message: `step ${i}`,
    ...(key ? { key } : {}),
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => entry(from + i));

  it('takes a short broadcast as the whole timeline', () => {
    expect(mergeTimeline(range(0, 80), range(0, 3))).toEqual(range(0, 3));
  });

  it('keeps the older entries a page holds before a full broadcast', () => {
    const held = range(0, 100);
    const tail = range(60, 60 + TIMELINE_BROADCAST);
    expect(mergeTimeline(held, tail)).toEqual(range(0, 60 + TIMELINE_BROADCAST));
  });

  it('lets a re-keyed entry in the broadcast replace the one held', () => {
    const held = [entry(0, 'a'), ...range(1, 80)];
    const tail = [...range(31, 80), { ...entry(99, 'a'), message: 'retried' }];
    expect(tail).toHaveLength(TIMELINE_BROADCAST);
    const out = mergeTimeline(held, tail);
    expect(out.filter((t) => t.key === 'a')).toEqual([{ ...entry(99, 'a'), message: 'retried' }]);
    expect(out).toHaveLength(80);
  });

  it('keeps what it held when the broadcast starts past it, up to the cap', () => {
    const out = mergeTimeline(range(0, TIMELINE_CAP), range(1000, 1000 + TIMELINE_BROADCAST));
    expect(out).toHaveLength(TIMELINE_CAP);
    expect(out.at(-1)).toEqual(entry(1000 + TIMELINE_BROADCAST - 1));
  });
});
