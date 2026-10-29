/**
 * The Catalog page: the product editor's board and a product's sheet, read from the catalog Worker
 * (`ProductCatalogRpc`), and the writes the page makes, each as the signed-in person and audited
 * `via: 'app'` with the same detail the REST API records (lib/catalog-api.server.ts). The assistant
 * drafts through the engine (`EngineRpc.draftProductContent`), which saves the drafts itself.
 */

import {
  type BoardCard,
  type BoardColumn,
  type BoardSummary,
  GAP_GROUPS,
  type GapGroup,
  type GapKind,
  gapGroup,
  type ProductSheet,
} from '@orderloop/core/product';
import { GROUP_KIND } from '~/components/catalog/labels';
import { catalog } from './env.server';

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
