import type { AuditActor, Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = { reindexProducts: vi.fn() };
const audit = vi.fn();
const signedActor = vi.fn(async (actor: unknown, call: string) => JSON.stringify({ actor, call }));
vi.mock('~/lib/env.server', () => ({ engine: () => engine }));
vi.mock('~/lib/audit.server', () => ({
  audit,
  actorName: (p: Principal) => p.email ?? p.name,
}));
vi.mock('~/lib/principal.server', () => ({ signedActor }));

const { updateProductIndex } = await import('~/lib/product-index.server');

const admin: Principal & AuditActor = {
  kind: 'user',
  id: 'usr_1',
  name: 'Ann',
  email: 'ann@example.com',
  role: 'admin',
};
const request = new Request('https://app.test/commerce', { method: 'POST' });

beforeEach(() => {
  audit.mockReset();
  engine.reindexProducts.mockReset();
  signedActor.mockClear();
});

describe('Update product index on the Commerce page', () => {
  it('runs for an admin, signed for the call, and audits what the run did', async () => {
    const run = { status: 'done', indexed: 1_200, removed: 3, more: true } as const;
    engine.reindexProducts.mockResolvedValueOnce({ ok: true, value: run });
    const r = await updateProductIndex(request, admin);
    expect(r).toEqual({
      ok: true,
      run,
      message:
        'Updated the product index: 1,200 added or renamed, 3 removed. More products are waiting; they follow within the hour, or run it again.',
    });
    expect(signedActor).toHaveBeenCalledWith(
      { kind: 'staff', id: 'usr_1', name: 'ann@example.com', role: 'admin' },
      'reindex-products',
    );
    expect(audit).toHaveBeenCalledWith(request, 'catalog.products_indexed', {
      actor: admin,
      detail: run,
    });
  });

  it('refuses anyone below Admin without asking the engine', async () => {
    const r = await updateProductIndex(request, { ...admin, role: 'operator' });
    expect(r).toEqual({ ok: false, error: 'This needs the Admin role.' });
    expect(engine.reindexProducts).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('says so when the workspace has no product index', async () => {
    engine.reindexProducts.mockResolvedValueOnce({ ok: true, value: { status: 'no_index' } });
    const r = await updateProductIndex(request, admin);
    expect(r).toMatchObject({
      ok: true,
      message:
        'This workspace has no product index, so extraction matches products by their SKUs and words alone.',
    });
    expect(audit).toHaveBeenCalledWith(request, 'catalog.products_indexed', {
      actor: admin,
      detail: { status: 'no_index' },
    });
  });

  it('answers a run already going (the hourly one, a double click) without running another', async () => {
    engine.reindexProducts.mockResolvedValueOnce({ ok: true, value: { status: 'busy' } });
    expect(await updateProductIndex(request, admin)).toMatchObject({
      ok: true,
      message: 'The product index is already being updated. Try again in a few minutes.',
    });
  });

  it('shows the engine’s refusal as it is, and a failed run as a retry', async () => {
    engine.reindexProducts.mockResolvedValueOnce({
      ok: false,
      error: 'This needs the Admin role.',
    });
    expect(await updateProductIndex(request, admin)).toEqual({
      ok: false,
      error: 'This needs the Admin role.',
    });
    engine.reindexProducts.mockRejectedValueOnce(new Error('embedding timed out'));
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    expect(await updateProductIndex(request, admin)).toMatchObject({ ok: false });
    expect(audit).not.toHaveBeenCalled();
  });
});
