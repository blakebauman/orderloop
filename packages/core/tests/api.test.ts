import { describe, expect, it } from 'vitest';
import { type StartOrderInput, startFingerprint } from '../src/api';
import type { OrderInput } from '../src/types';

const input: OrderInput = {
  type: 'b2b_order',
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
        type: 'b2b_order',
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
