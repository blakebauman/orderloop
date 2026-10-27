import { BOARD_COLUMNS, type BoardColumn, GAP_KINDS, type GapKind } from '@orderloop/core/product';
import { data } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import { loadCards } from '~/lib/catalog-board.server';
import type { Route } from './+types/catalog-cards';

/** The Catalog board's next cards: a column's, or one kind of gap's, after `cursor`. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = new URL(request.url).searchParams;
  const column = q.get('column') ?? '';
  const kind = q.get('kind');
  if (!(BOARD_COLUMNS as readonly string[]).includes(column))
    return data({ error: 'No such column' }, { status: 404 });
  if (kind && !(GAP_KINDS as readonly string[]).includes(kind))
    return data({ error: 'No such kind' }, { status: 400 });
  return loadCards(
    column as BoardColumn,
    (kind as GapKind | null) ?? undefined,
    q.get('cursor') ?? undefined,
  );
}
