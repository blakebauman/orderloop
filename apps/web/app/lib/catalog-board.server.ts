/**
 * The Catalog page: the product editor's board and a product's sheet, read from the catalog Worker
 * (`ProductCatalogRpc`), and the writes the page makes, each as the signed-in person and audited
 * `via: 'app'` with the same detail the REST API records (lib/catalog-api.server.ts). The assistant
 * drafts through the engine (`EngineRpc.draftProductContent`), which saves the drafts itself.
 */

import type { Principal } from '@orderloop/core';
import {
  type BoardCard,
  type BoardColumn,
  type BoardSummary,
  GAP_GROUPS,
  type GapGroup,
  type GapKind,
  gapGroup,
  type ProductDraftResult,
  type ProductSheet,
  type PublishResult,
  type StageEdit,
} from '@orderloop/core/product';
import type { z } from 'zod';
import { GROUP_KIND } from '~/components/catalog/labels';
import type { catalogDiscardInput, catalogDraftContentInput } from './api-schemas';
import { actorName, audit } from './audit.server';
import { catalog, engine } from './env.server';
import { signedActor } from './principal.server';

/** Cards a Gaps group shows before "Show all"; the other columns show a page. */
export const GROUP_CARDS = 6;
export const COLUMN_CARDS = 40;

export type CardPage = { cards: BoardCard[]; cursor: string | null };

export type BoardView = {
  summary: BoardSummary;
  /** The Gaps column's groups (`GAP_GROUPS`), each product in one, with the first of each. */
  gaps: ({ id: GapGroup; kind?: GapKind; products: number } & CardPage)[];
  columns: Record<Exclude<BoardColumn, 'gaps'>, CardPage>;
};

export async function loadBoard(): Promise<BoardView> {
  const c = catalog();
  const summary = await c.catalogBoard();
  const page = async (column: BoardColumn, limit: number, kind?: GapKind) => {
    const p = await c.listBoard({ column, kind, limit });
    return { cards: p.items, cursor: p.cursor ?? null };
  };
  const groups = GAP_GROUPS.filter((g) => summary.gapGroups[g]);
  const [gaps, drafted, staged, published] = await Promise.all([
    Promise.all(
      groups.map(async (g) => {
        const kind = GROUP_KIND[g];
        const first = await page('gaps', GROUP_CARDS, kind);
        return {
          id: g,
          ...(kind ? { kind } : {}),
          products: summary.gapGroups[g],
          cards: first.cards.filter((card) => gapGroup(card.kinds) === g),
          cursor: first.cursor,
        };
      }),
    ),
    page('drafted', COLUMN_CARDS),
    page('staged', COLUMN_CARDS),
    page('published', COLUMN_CARDS),
  ]);
  // A group whose products all moved on (drafted or staged) has nothing left in Gaps.
  return {
    summary,
    gaps: gaps.filter((g) => g.cards.length || g.cursor),
    columns: { drafted, staged, published },
  };
}

/** The next cards of a column (or one kind of gap), after `cursor`. */
export async function loadCards(
  column: BoardColumn,
  kind: GapKind | undefined,
  cursor: string | undefined,
): Promise<CardPage> {
  const p = await catalog().listBoard({ column, kind, cursor, limit: COLUMN_CARDS });
  return { cards: p.items, cursor: p.cursor ?? null };
}

export const loadSheet = (key: string): Promise<ProductSheet | null> =>
  catalog().getProductSheet(key);

/**
 * The labels a product type gives its attributes, by code, in English where it has one. Types only
 * add attributes between versions, so the latest version names every code a product of it uses.
 */
export async function attributeLabels(type: string): Promise<Record<string, string>> {
  const code = type.split('@')[0];
  const def = (await catalog().listTypes()).find((t) => t.code === code);
  const labels: Record<string, string> = {};
  for (const a of def?.attributes ?? []) {
    const label = a.label?.en ?? Object.values(a.label ?? {})[0];
    if (label) labels[a.code] = label;
  }
  return labels;
}

const by = (me: Principal) => me.email ?? me.id;

/** Stages edits as `me`; answers per edit. Accepting a draft is staging it with `source: 'assistant'`. */
export async function stageEdits(request: Request, me: Principal, edits: StageEdit[]) {
  const results = await catalog().stageEdits(edits, by(me));
  const staged = results.filter((r) => r.ok);
  if (results.length)
    await audit(request, 'catalog.edits_staged', {
      actor: me,
      detail: {
        staged: staged.length,
        refused: results.length - staged.length,
        products: new Set(staged.map((r) => r.key)).size,
        fromDrafts: edits.filter((e, i) => e.source === 'assistant' && results[i]?.ok).length,
        via: 'app',
      },
    });
  return results;
}

/** Stages each of a product's drafts that the field hasn't moved past, as the assistant's text. */
export async function acceptDrafts(request: Request, me: Principal, key: string) {
  const sheet = await loadSheet(key);
  const fresh = sheet?.drafts.filter((d) => !d.stale) ?? [];
  return stageEdits(
    request,
    me,
    fresh.map((d) => ({ key, ref: d.ref, op: 'set', value: d.value, source: 'assistant' })),
  );
}

type Items = z.infer<typeof catalogDiscardInput>['items'];

export async function discardStaged(request: Request, me: Principal, items: Items) {
  const r = await catalog().discardStaged(items, by(me));
  await audit(request, 'catalog.edits_discarded', {
    actor: me,
    detail: { discarded: r.discarded, via: 'app' },
  });
  return r;
}

export async function discardDrafts(request: Request, me: Principal, items: Items) {
  const r = await catalog().discardDrafts(items, by(me));
  await audit(request, 'catalog.drafts_discarded', {
    actor: me,
    detail: { discarded: r.discarded, via: 'app' },
  });
  return r;
}

/**
 * Publishes these products' staged edits, each product's all or none. `requestId` comes from the
 * page, so pressing Publish again after a lost answer gets the first answer, not a second publish.
 */
export async function publish(
  request: Request,
  me: Principal,
  keys: string[],
  requestId: string,
): Promise<PublishResult[]> {
  const results = await catalog().publishStaged(keys, { by: by(me), requestId });
  const count = (s: PublishResult['status']) => results.filter((r) => r.status === s).length;
  await audit(request, 'catalog.edits_published', {
    actor: me,
    detail: {
      published: count('published'),
      failed: count('failed'),
      unchanged: count('unchanged'),
      keys: results
        .filter((r) => r.status === 'published')
        .map((r) => r.key)
        .slice(0, 50),
      requestId,
      urgent: false,
      via: 'app',
    },
  });
  return results;
}

/** Has the assistant draft a product's missing text (or `fields`) as drafts on the product. */
export async function draftProduct(
  request: Request,
  me: Principal,
  key: string,
  ask: z.infer<typeof catalogDraftContentInput>,
): Promise<{ ok: true; value: ProductDraftResult } | { ok: false; error: string }> {
  const r = await engine().draftProductContent(
    key,
    ask,
    await signedActor(
      { kind: 'staff', id: me.id, name: actorName(me), role: me.role },
      `draft-product:${key}`,
    ),
  );
  if (r.ok && r.value.drafted.length)
    await audit(request, 'catalog.drafts_saved', {
      actor: me,
      target: key,
      detail: {
        saved: r.value.drafted.length,
        refused: r.value.refused.length,
        model: r.value.model,
        via: 'app',
      },
    });
  return r;
}
