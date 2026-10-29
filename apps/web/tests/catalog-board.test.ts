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
  listTypes: vi.fn(),
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
const { cardReason, fieldLabel, issueText } = await import('~/components/catalog/labels');
const { gapGroup } = await import('@orderloop/core/product');

const ops: Principal = {
  kind: 'user',
  id: 'usr_o',
  name: 'Ops',
  email: 'ops@example.com',
  role: 'operator',
};
const _request = new Request('https://app.test/catalog');

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
            issues: [{ path: 'variants', message: 'Too small: expected array to have >=1 items' }],
            at: 0,
          },
        }),
      ),
    ).toBe('Row 4 refused: Needs at least one variant · Missing title\u00a0×2, alt\u00a0text');
    expect(cardReason(card({ column: 'drafted', drafts: 1 }))).toBe('1 draft to review');
    expect(cardReason(card({ column: 'staged', staged: 3, failure: 'slug taken' }))).toBe(
      'Didn’t publish: slug taken',
    );
    expect(gapGroup({ rejected: 1, missing_required: 1 })).toBe('rejected');
    expect(gapGroup({ missing_alt: 1 })).toBe('missing');
  });
});

describe('validation issues in words', () => {
  it("reads zod's common issues as sentences", () => {
    expect(
      issueText({ path: 'variants', message: 'Too small: expected array to have >=1 items' }),
    ).toBe('Needs at least one variant');
    expect(
      issueText({ path: 'images', message: 'Too small: expected array to have >=2 items' }),
    ).toBe('Needs at least 2 images');
    expect(
      issueText({ path: 'title.en', message: 'Too small: expected string to have >=1 characters' }),
    ).toBe('Title (en) is empty');
    expect(
      issueText({
        path: 'variants.0.sku',
        message: 'Invalid input: expected string, received undefined',
      }),
    ).toBe('Variant 1 SKU is missing');
    expect(
      issueText({
        path: 'attributes.weight',
        message: 'Invalid input: expected number, received string',
      }),
    ).toBe('Weight should be a number');
    expect(issueText({ path: 'attributes.care', message: 'required' })).toBe('Care is missing');
  });

  it('keeps a message it does not know, after where it is', () => {
    expect(issueText({ path: 'variants.1.sku', message: 'duplicate SKU' })).toBe(
      'Variant 2 SKU: duplicate SKU',
    );
    expect(
      issueText({ path: 'slug.en', message: 'Invalid string: must match pattern /^[a-z]/' }),
    ).toBe('Slug (en): must match pattern /^[a-z]/');
    expect(issueText({ path: '', message: 'over 65536 bytes' })).toBe('Over 65536 bytes');
  });
});

describe('field labels', () => {
  it("names an attribute by its type's label, else its code in words", () => {
    expect(fieldLabel({ field: 'attribute', code: 'care' }, { care: 'Care instructions' })).toBe(
      'Care instructions',
    );
    expect(fieldLabel({ field: 'attribute', code: 'care' })).toBe('Care');
    expect(fieldLabel({ field: 'attribute', code: 'fabric_weight' })).toBe('Fabric weight');
    expect(fieldLabel({ field: 'attribute', code: 'sku' })).toBe('SKU');
    expect(fieldLabel({ field: 'title' })).toBe('Title');
  });

  it("reads the labels from the product's type, latest version", async () => {
    catalog.listTypes.mockResolvedValue([
      {
        code: 'apparel',
        version: 2,
        attributes: [
          { code: 'care', label: { en: 'Care instructions', fr: 'Entretien' } },
          { code: 'fit', label: { de: 'Passform' } },
          { code: 'gsm' },
        ],
      },
    ]);
    expect(await board.attributeLabels('apparel@1')).toEqual({
      care: 'Care instructions',
      fit: 'Passform',
    });
    expect(await board.attributeLabels('unknown')).toEqual({});
  });
});
