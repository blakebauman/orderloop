import type { Principal } from '@orderloop/core';
import type { BoardCard } from '@orderloop/core/product';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = {
  catalogBoard: vi.fn(),
  listBoard: vi.fn(),
  getProductSheet: vi.fn(),
  stageEdits: vi.fn(),
  discardStaged: vi.fn(),
  discardDrafts: vi.fn(),
  publishStaged: vi.fn(),
};
const engine = { draftProductContent: vi.fn() };
const audit = vi.fn();
let caller: Principal | null = null;

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ catalog: () => catalog, engine: () => engine }));
vi.mock('~/lib/audit.server', () => ({ audit, actorName: (a: Principal) => a.email ?? a.name }));
vi.mock('~/lib/principal.server', () => ({
  signedActor: async (a: unknown, call: string) => JSON.stringify({ a, call }),
}));
vi.mock('~/lib/auth.server', () => ({
  requireUser: async (_r: Request, min = 'viewer') => {
    if (!caller || (min === 'operator' && caller.role === 'viewer'))
      throw new Response('Forbidden', { status: 403 });
    return caller;
  },
}));

const board = await import('~/lib/catalog-board.server');
const { action } = await import('~/routes/catalog-action');
const { cardReason } = await import('~/components/catalog/labels');
const { gapGroup } = await import('@orderloop/core/product');

const ops: Principal = {
  kind: 'user',
  id: 'usr_o',
  name: 'Ops',
  email: 'ops@example.com',
  role: 'operator',
};
const request = new Request('https://app.test/catalog');

const card = (over: Partial<BoardCard>): BoardCard => ({
  key: 'tee',
  title: 'Tee',
  column: 'gaps',
  kinds: {},
  rejection: null,
  locales: [],
  staged: 0,
  drafts: 0,
  failure: null,
  at: 0,
  ...over,
});

const post = (body: unknown) =>
  action({
    request: new Request('https://app.test/catalog/action', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never);

/** A `data()` answer's status and body, or a plain object's. */
const answer = (r: unknown) => {
  const d = r as { type?: string; data?: unknown; init?: { status?: number } };
  return d?.type === 'DataWithResponseInit'
    ? { status: d.init?.status ?? 200, body: d.data }
    : { status: 200, body: r };
};

beforeEach(() => {
  for (const fn of [...Object.values(catalog), ...Object.values(engine), audit]) fn.mockReset();
  caller = ops;
});

describe('the board', () => {
  it('groups Gaps so each product shows once, needing a person first, and drops empty groups', async () => {
    catalog.catalogBoard.mockResolvedValue({
      columns: { gaps: 3, drafted: 0, staged: 0, published: 0 },
      gapGroups: { conflict: 1, rejected: 0, missing_required: 0, missing: 1 },
      gapsByKind: {
        conflict: { gaps: 1, products: 1 },
        missing_title: { gaps: 4, products: 3 },
      },
      lastFeed: null,
      runningFeed: null,
      indexBuilt: true,
    });
    const conflicted = card({ key: 'a', kinds: { conflict: 1, missing_title: 1 } });
    catalog.listBoard.mockImplementation(async ({ column, kind }) => {
      if (column !== 'gaps') return { items: [], cursor: null };
      if (kind === 'conflict') return { items: [conflicted], cursor: null };
      return {
        items: [conflicted, card({ key: 'b', kinds: { missing_title: 2 } })],
        cursor: 'b',
      };
    });
    const view = await board.loadBoard();
    // Only kinds the board has are asked for; Missing text reads the column, not one kind.
    expect(catalog.listBoard).toHaveBeenCalledWith({ column: 'gaps', kind: 'conflict', limit: 6 });
    expect(catalog.listBoard).toHaveBeenCalledWith({ column: 'gaps', kind: undefined, limit: 6 });
    expect(view.gaps.map((g) => [g.id, g.cards.map((c) => c.key), g.cursor])).toEqual([
      ['conflict', ['a'], null],
      ['missing', ['b'], 'b'],
    ]);
  });

  it('says why each card is where it is', () => {
    expect(
      cardReason(
        card({
          kinds: { missing_title: 2, missing_alt: 1 },
          rejection: {
            row: 4,
            issues: [{ path: 'variants', message: 'Too small' }],
            at: 0,
          },
        }),
      ),
    ).toBe('Row 4 refused: variants: Too small · Missing title\u00a0×2, alt\u00a0text');
    expect(cardReason(card({ column: 'drafted', drafts: 1 }))).toBe('1 draft to review');
    expect(cardReason(card({ column: 'staged', staged: 3, failure: 'slug taken' }))).toBe(
      'Didn’t publish: slug taken',
    );
    expect(gapGroup({ rejected: 1, missing_required: 1 })).toBe('rejected');
    expect(gapGroup({ missing_alt: 1 })).toBe('missing');
  });
});

describe('writes from the page', () => {
  it('stages as the person and audits via the app, counting accepted drafts', async () => {
    catalog.stageEdits.mockResolvedValue([
      { key: 'tee', ref: { field: 'title', locale: 'fr' }, ok: true },
      { key: 'tee', ref: { field: 'slug', locale: 'fr' }, ok: false, issues: ['bad slug'] },
    ]);
    const edits = [
      {
        key: 'tee',
        ref: { field: 'title' as const, locale: 'fr' },
        op: 'set' as const,
        value: 'T',
        source: 'assistant' as const,
      },
      {
        key: 'tee',
        ref: { field: 'slug' as const, locale: 'fr' },
        op: 'set' as const,
        value: 'Bad Slug',
      },
    ];
    await board.stageEdits(request, ops, edits);
    expect(catalog.stageEdits).toHaveBeenCalledWith(edits, 'ops@example.com');
    expect(audit).toHaveBeenCalledWith(request, 'catalog.edits_staged', {
      actor: ops,
      detail: { staged: 1, refused: 1, products: 1, fromDrafts: 1, via: 'app' },
    });
  });

  it("accepts a product's drafts the field hasn't moved past, as the assistant's text", async () => {
    const titleFr = { field: 'title', locale: 'fr' };
    catalog.getProductSheet.mockResolvedValue({
      drafts: [
        { ref: titleFr, value: 'T-shirt', stale: false },
        { ref: { field: 'description', locale: 'fr' }, value: 'Vieux', stale: true },
      ],
    });
    catalog.stageEdits.mockResolvedValue([{ key: 'tee', ref: titleFr, ok: true }]);
    await board.acceptDrafts(request, ops, 'tee');
    expect(catalog.stageEdits).toHaveBeenCalledWith(
      [{ key: 'tee', ref: titleFr, op: 'set', value: 'T-shirt', source: 'assistant' }],
      'ops@example.com',
    );
  });

  it('publishes with the page’s request id and audits what went live', async () => {
    catalog.publishStaged.mockResolvedValue([
      { key: 'a', status: 'published', version: 2 },
      { key: 'b', status: 'failed', issues: ['changed since'] },
    ]);
    await board.publish(request, ops, ['a', 'b'], 'req-1');
    expect(catalog.publishStaged).toHaveBeenCalledWith(['a', 'b'], {
      by: 'ops@example.com',
      requestId: 'req-1',
    });
    expect(audit).toHaveBeenCalledWith(request, 'catalog.edits_published', {
      actor: ops,
      detail: expect.objectContaining({
        published: 1,
        failed: 1,
        keys: ['a'],
        requestId: 'req-1',
        via: 'app',
      }),
    });
  });

  it('has the engine draft as the person signed for that product, and audits only what it saved', async () => {
    engine.draftProductContent.mockResolvedValue({
      ok: true,
      value: { key: 'tee', title: 'Tee', drafted: [{}], refused: [], more: 0, model: 'm' },
    });
    await board.draftProduct(request, ops, 'tee', {});
    expect(engine.draftProductContent).toHaveBeenCalledWith(
      'tee',
      {},
      JSON.stringify({
        a: { kind: 'staff', id: 'usr_o', name: 'ops@example.com', role: 'operator' },
        call: 'draft-product:tee',
      }),
    );
    expect(audit).toHaveBeenCalledWith(request, 'catalog.drafts_saved', {
      actor: ops,
      target: 'tee',
      detail: { saved: 1, refused: 0, model: 'm', via: 'app' },
    });
    audit.mockReset();
    engine.draftProductContent.mockResolvedValue({ ok: false, error: 'Nothing to draft' });
    expect(await board.draftProduct(request, ops, 'tee', {})).toEqual({
      ok: false,
      error: 'Nothing to draft',
    });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('/catalog/action', () => {
  it('needs an operator', async () => {
    caller = { ...ops, role: 'viewer' };
    await expect(post({ intent: 'accept', key: 'tee' })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses what doesn’t read, and answers a refused draft 422', async () => {
    expect(answer(await post('{nope')).status).toBe(400);
    expect(answer(await post({ intent: 'publish', keys: ['a'] }))).toMatchObject({ status: 400 });
    expect(answer(await post({ intent: 'stage', edits: [] }))).toMatchObject({ status: 400 });
    expect(answer(await post({ intent: 'shred' }))).toMatchObject({ status: 400 });
    engine.draftProductContent.mockResolvedValue({ ok: false, error: 'Nothing to draft' });
    expect(answer(await post({ intent: 'draft', key: 'tee' }))).toEqual({
      status: 422,
      body: { ok: false, error: 'Nothing to draft' },
    });
    expect(catalog.publishStaged).not.toHaveBeenCalled();
  });

  it('publishes the keys with the request id the page sent', async () => {
    catalog.publishStaged.mockResolvedValue([{ key: 'a', status: 'published', version: 2 }]);
    expect(answer(await post({ intent: 'publish', keys: ['a'], requestId: 'r1' })).body).toEqual({
      ok: true,
      results: [{ key: 'a', status: 'published', version: 2 }],
    });
  });
});
