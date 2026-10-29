/**
 * The product editor's board: what the last feed left wrong or missing, moving left to right toward
 * live. Gaps (grouped by kind), Drafted (the assistant's drafts to review), Staged (edits waiting to
 * publish, Publish at its head) and Published today. A card opens the product's sheet. See
 * docs/product-editor.md and lib/catalog-board.server.ts.
 */

import {
  BOARD_COLUMNS,
  type BoardCard,
  type BoardColumn,
  type GapGroup,
  type GapKind,
  gapGroup,
} from '@orderloop/core/product';
import { Badge } from '@orderloop/ui/badge';
import { Button } from '@orderloop/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@orderloop/ui/collapsible';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import { Kbd } from '@orderloop/ui/kbd';
import { cn } from '@orderloop/ui/lib/utils';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { ChevronRight, PackageCheck } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { Ago } from '~/components/ago';
import {
  COLUMN_LABEL,
  cardReason,
  draftable,
  GROUP_LABEL,
  missingText,
} from '~/components/catalog/labels';
import { ProductSheetView } from '~/components/catalog/sheet';
import { catalogWrite, refusal, useCatalogAction } from '~/components/catalog/use-action';
import { Body, Empty, PageHeader } from '~/components/page';
import { useAssistant } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import {
  attributeLabels,
  type BoardView,
  type CardPage,
  loadBoard,
  loadSheet,
} from '~/lib/catalog-board.server';
import { count } from '~/lib/format';
import { EASE, MOTION } from '~/lib/motion';
import { pageShortcut } from '~/lib/shortcuts';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/catalog';

export const meta = () => [{ title: 'Catalog · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const key = new URL(request.url).searchParams.get('product');
  const [board, sheet] = await Promise.all([loadBoard(), key ? loadSheet(key) : null]);
  const labels = sheet ? await attributeLabels(sheet.product.type) : {};
  return { board, sheet, attributeLabels: labels, missing: key && !sheet ? key : null };
}

/** Each column's mark: the status it is, or none. Green is for live only. */
const COLUMN_DOT: Record<BoardColumn, string | null> = {
  gaps: 'var(--wait)',
  drafted: 'var(--ai)',
  staged: null,
  published: 'var(--ok)',
};

/** How long the board waits between refreshes while nothing is open over it. */
const REFRESH_MS = 20_000;

export default function Catalog() {
  const { board, sheet, attributeLabels: labels, missing } = useLoaderData<typeof loader>();
  const canEdit = useCan('operator');
  const [params, setParams] = useSearchParams();
  const { revalidate } = useRevalidator();
  const root = useRef<HTMLDivElement>(null);
  useFlip(root, board);
  const counts = board.summary.columns;
  const firstFull = BOARD_COLUMNS.find((c) => counts[c]) ?? 'gaps';
  const [phoneView, setPhoneView] = useState<BoardColumn>(firstFull);
  const openKey = params.get('product');
  const close = () =>
    setParams(
      (p) => {
        p.delete('product');
        return p;
      },
      { preventScrollReset: true, replace: true },
    );
  // Feeds land while the page is open: refresh now and then, but never under an open sheet or a
  // batch the person started.
  const [batch, setBatch] = useState<Batch | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!openKey && !batch && document.visibilityState === 'visible') revalidate();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [openKey, batch, revalidate]);
  useBoardKeys(root);

  const empty = BOARD_COLUMNS.every((c) => !counts[c]);
  return (
    <>
      <PageHeader title="Catalog" subtitle={<FeedLine summary={board.summary} />} />
      <Body>
        {!board.summary.indexBuilt ? (
          <p className="mb-4 text-muted-foreground text-sm" role="status">
            Still counting the gaps of products stored before the board existed; some may be missing
            until it finishes.
          </p>
        ) : null}
        {empty ? (
          <Card>
            <Empty icon={<PackageCheck aria-hidden="true" />} title="Nothing is waiting">
              {board.summary.lastFeed ? 'The last feed left no gaps, no' : 'No'} drafts are waiting
              for review and nothing is staged. Products a feed leaves without a title or a
              translation show up here.
            </Empty>
          </Card>
        ) : (
          <>
            <Segmented
              aria-label="Show column"
              className="mb-4 flex w-full overflow-x-auto lg:hidden"
              value={phoneView}
              onValueChange={(v) => setPhoneView(v as BoardColumn)}
            >
              {BOARD_COLUMNS.map((c) => (
                <SegmentedItem key={c} value={c} className="flex-1">
                  {c === 'published' ? 'Today' : COLUMN_LABEL[c]}
                  <span className="tabular text-muted-foreground">{count(counts[c])}</span>
                </SegmentedItem>
              ))}
            </Segmented>
            {canEdit ? (
              <p className="mb-3 hidden max-w-[75ch] text-muted-foreground text-xs leading-6 fine:lg:block">
                Keyboard: <Kbd>J</Kbd> and <Kbd>K</Kbd> move between cards, <Kbd>Enter</Kbd> opens
                one, <Kbd>D</Kbd> drafts it, <Kbd>A</Kbd> accepts its drafts, <Kbd>X</Kbd> ticks it
                for publishing and <Kbd>⌘Enter</Kbd> publishes what’s ticked.
              </p>
            ) : null}
            <div
              ref={root}
              className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]"
            >
              <GapsColumn
                board={board}
                canEdit={canEdit}
                hidden={phoneView !== 'gaps'}
                batch={batch}
                setBatch={setBatch}
                onDone={revalidate}
              />
              <CardColumn
                column="drafted"
                page={board.columns.drafted}
                total={counts.drafted}
                canEdit={canEdit}
                hidden={phoneView !== 'drafted'}
                empty="No drafts to review. Ask the assistant to draft a product’s missing text from a card in Gaps."
              />
              <StagedColumn
                page={board.columns.staged}
                total={counts.staged}
                canEdit={canEdit}
                hidden={phoneView !== 'staged'}
              />
              <CardColumn
                column="published"
                page={board.columns.published}
                total={counts.published}
                canEdit={canEdit}
                hidden={phoneView !== 'published'}
                empty="Nothing published in the last day."
              />
            </div>
          </>
        )}
      </Body>
      {sheet ? (
        <ProductSheetView
          key={sheet.product.key}
          sheet={sheet}
          attributeLabels={labels}
          canEdit={canEdit}
          onClose={close}
        />
      ) : null}
      {missing ? (
        <p role="alert" className="sr-only">
          The catalog has no product {missing}.
        </p>
      ) : null}
    </>
  );
}

/** The last feed in one line, and one still running. */
function FeedLine({ summary }: { summary: BoardView['summary'] }) {
  const last = summary.lastFeed;
  const running = summary.runningFeed;
  return (
    <>
      {last ? (
        <>
          Last feed <span className="font-mono text-xs">{last.name}</span>,{' '}
          <Ago ms={last.finishedAt ?? last.createdAt} />:{' '}
          {[
            [last.created, 'created'],
            [last.updated, 'updated'],
            [last.rejected, 'refused'],
          ]
            .filter(([n]) => n)
            .map(([n, what]) => `${count(n as number)} ${what}`)
            .join(', ') || 'nothing changed'}
          .
        </>
      ) : (
        'No feed has finished yet; products written through the API show up here too.'
      )}
      {running ? (
        <>
          {' '}
          Importing <span className="font-mono text-xs">{running.name}</span>: {running.partsDone}{' '}
          of {running.parts} parts.
        </>
      ) : null}
    </>
  );
}

/** What each column holds, under its title. */
const COLUMN_DESCRIPTION: Record<BoardColumn, string> = {
  gaps: 'What the last feed left wrong or missing.',
  drafted: 'The assistant’s drafts, to review.',
  staged: 'Edits waiting to publish.',
  published: 'Published in the last day.',
};

/**
 * A column of the board, as a card: its header (the status dot, title and count, what it holds, and
 * its one action), then its rows. Below lg one column shows at a time under the segmented control,
 * which names it, so the header is for screen readers only.
 */
function ColumnShell({
  column,
  total,
  hidden,
  actions,
  children,
}: {
  column: BoardColumn;
  total: number;
  hidden: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const dot = COLUMN_DOT[column];
  return (
    <section aria-labelledby={`col-${column}`} className={cn('min-w-0', hidden && 'max-lg:hidden')}>
      {/* Clip, not hidden: rows glide in from other columns, and a hidden card would scroll. */}
      <Card size="sm" className="relative gap-3 overflow-clip pb-2 max-lg:pt-2">
        <CardHeader className="max-lg:sr-only">
          <CardTitle className="section-title">
            <h2 id={`col-${column}`} className="flex items-center gap-2">
              {dot ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: dot }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full border border-foreground/60"
                />
              )}
              {COLUMN_LABEL[column]}
              <Badge variant="secondary" className="tabular">
                {count(total)}
              </Badge>
            </h2>
          </CardTitle>
          <CardDescription className="text-xs">{COLUMN_DESCRIPTION[column]}</CardDescription>
          {actions ? <CardAction className="self-center">{actions}</CardAction> : null}
        </CardHeader>
        <div className="min-w-0">{children}</div>
      </Card>
    </section>
  );
}

type Batch = {
  group: GapGroup;
  total: number;
  done: number;
  /** Per product: running, drafted, or why not. */
  rows: Record<string, 'running' | 'done' | { error: string }>;
};

function GapsColumn({
  board,
  canEdit,
  hidden,
  batch,
  setBatch,
  onDone,
}: {
  board: BoardView;
  canEdit: boolean;
  hidden: boolean;
  batch: Batch | null;
  setBatch: (b: Batch | null | ((b: Batch | null) => Batch | null)) => void;
  onDone: () => void;
}) {
  const [closed, setClosed] = useState<Set<GapGroup>>(new Set());
  const { act } = useAssistant();
  const draftAll = async (group: GapGroup, cards: BoardCard[]) => {
    const keys = cards.map((c) => c.key);
    setBatch({
      group,
      total: keys.length,
      done: 0,
      rows: Object.fromEntries(keys.map((k) => [k, 'running'])),
    });
    for (const key of keys) {
      let result: Batch['rows'][string];
      // One product at a time, each its own tool call through the assistant.
      const a = await catalogWrite(act, { intent: 'draft', key });
      result = a?.ok ? 'done' : { error: a?.error ?? 'It couldn’t be drafted.' };
      setBatch((b) => (b ? { ...b, done: b.done + 1, rows: { ...b.rows, [key]: result } } : b));
    }
    onDone();
  };
  return (
    <ColumnShell column="gaps" total={board.summary.columns.gaps} hidden={hidden}>
      {board.gaps.length ? (
        <div className="divide-y">
          {board.gaps.map((g) => (
            <GapSection
              key={g.id}
              group={g}
              canEdit={canEdit}
              closed={closed.has(g.id)}
              toggle={() =>
                setClosed((s) => {
                  const n = new Set(s);
                  if (n.has(g.id)) n.delete(g.id);
                  else n.add(g.id);
                  return n;
                })
              }
              batch={batch?.group === g.id ? batch : null}
              busy={!!batch && batch.done < batch.total}
              onDraftAll={(cards) => void draftAll(g.id, cards)}
              onClearBatch={() => setBatch(null)}
            />
          ))}
        </div>
      ) : (
        <Empty>
          No gaps. Every product has its text in each locale of the channels it is listed in.
        </Empty>
      )}
    </ColumnShell>
  );
}

function GapSection({
  group,
  canEdit,
  closed,
  toggle,
  batch,
  busy,
  onDraftAll,
  onClearBatch,
}: {
  group: BoardView['gaps'][number];
  canEdit: boolean;
  closed: boolean;
  toggle: () => void;
  batch: Batch | null;
  busy: boolean;
  onDraftAll: (cards: BoardCard[]) => void;
  onClearBatch: () => void;
}) {
  const more = useMorePages('gaps', group.kind, group);
  // Each product once: later pages bring the ones another group already shows.
  const cards = [...group.cards, ...more.cards.filter((c) => gapGroup(c.kinds) === group.id)];
  const canDraft = canEdit && group.id === 'missing';
  const id = `gap-${group.id}`;
  return (
    <Collapsible asChild open={!closed} onOpenChange={toggle}>
      <section aria-labelledby={id}>
        <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
          <CollapsibleTrigger
            id={id}
            className="hit-area caption -ml-1 flex items-center gap-1 rounded-full px-1 hover:text-foreground"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3.5 transition-[rotate] duration-200', !closed && 'rotate-90')}
            />
            {GROUP_LABEL[group.id]}
            <span className="tabular">· {count(group.products)}</span>
          </CollapsibleTrigger>
          {canDraft && !closed ? (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto max-lg:hidden"
              disabled={busy}
              onClick={() => onDraftAll(cards)}
              title="Have the assistant draft each product shown here, one after another"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-ai" />
              {more.cursor || cards.length < group.products
                ? `Draft the ${cards.length} shown`
                : `Draft these ${cards.length}`}
            </Button>
          ) : null}
        </div>
        {batch ? (
          <p
            role="status"
            className="flex items-center gap-2 px-4 pb-1.5 text-muted-foreground text-xs"
          >
            {batch.done < batch.total
              ? `Drafting ${batch.done + 1} of ${batch.total}…`
              : `Drafted ${Object.values(batch.rows).filter((r) => r === 'done').length} of ${batch.total}; they’re in Drafted.`}
            {batch.done === batch.total ? (
              <button type="button" className="text-link hover:underline" onClick={onClearBatch}>
                Dismiss
              </button>
            ) : null}
          </p>
        ) : null}
        <CollapsibleContent>
          <ul className="flex flex-col gap-0.5 px-1.5 pb-1">
            {cards.map((c) => (
              <CardRow key={c.key} card={c} canEdit={canEdit} flip state={batch?.rows[c.key]} />
            ))}
          </ul>
          {more.cursor ? (
            <button
              type="button"
              className="hit-area px-4 pt-1 pb-3 text-link text-xs hover:underline disabled:opacity-60"
              disabled={more.loading}
              onClick={more.load}
            >
              {more.loading ? 'Loading…' : 'Show more'}
            </button>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** A column's (or a gap kind's) next pages, appended under its first. */
function useMorePages(column: BoardColumn, kind: GapKind | undefined, first: CardPage) {
  const fetcher = useFetcher<CardPage>();
  const [pages, setPages] = useState<CardPage[]>([]);
  // The board refreshed: start again from its first page.
  useEffect(() => setPages([]), [first]);
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && 'cards' in fetcher.data) {
      const page = fetcher.data;
      setPages((p) => (p.at(-1) === page ? p : [...p, page]));
    }
  }, [fetcher.state, fetcher.data]);
  const cursor = pages.length ? (pages.at(-1)?.cursor ?? null) : first.cursor;
  return {
    cards: pages.flatMap((p) => p.cards),
    cursor,
    loading: fetcher.state !== 'idle',
    load: () => {
      if (!cursor) return;
      const q = new URLSearchParams({ column, cursor, ...(kind ? { kind } : {}) });
      fetcher.load(`/catalog/cards?${q}`);
    },
  };
}

function CardColumn({
  column,
  page,
  total,
  canEdit,
  hidden,
  empty,
}: {
  column: 'drafted' | 'published';
  page: CardPage;
  total: number;
  canEdit: boolean;
  hidden: boolean;
  empty: string;
}) {
  const more = useMorePages(column, undefined, page);
  const cards = [...page.cards, ...more.cards];
  return (
    <ColumnShell column={column} total={total} hidden={hidden}>
      {cards.length ? (
        <ul className="flex flex-col gap-0.5 px-1.5">
          {cards.map((c) => (
            <CardRow key={c.key} card={c} canEdit={canEdit} flip />
          ))}
        </ul>
      ) : (
        <Empty>{empty}</Empty>
      )}
      {more.cursor ? <ShowMore more={more} /> : null}
    </ColumnShell>
  );
}

function ShowMore({ more }: { more: ReturnType<typeof useMorePages> }) {
  return (
    <button
      type="button"
      className="hit-area block px-4 pt-1 pb-3 text-link text-xs hover:underline disabled:opacity-60"
      disabled={more.loading}
      onClick={more.load}
    >
      {more.loading ? 'Loading…' : 'Show more'}
    </button>
  );
}

/**
 * Staged: Publish at its head, for the ticked products (all, unless some are unticked). One request
 * id per batch, so pressing Publish again after a lost answer gets the first answer back.
 */
function StagedColumn({
  page,
  total,
  canEdit,
  hidden,
}: {
  page: CardPage;
  total: number;
  canEdit: boolean;
  hidden: boolean;
}) {
  const more = useMorePages('staged', undefined, page);
  const cards = [...page.cards, ...more.cards];
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = cards.filter((c) => !unticked.has(c.key)).map((c) => c.key);
  // Publishing asks on the assistant's card, which lists what goes live; it is keyed by that card,
  // so pressing again after a lost answer can't publish twice.
  const pub = useCatalogAction();
  const answer = pub.answer;
  const publish = useCallback(() => {
    if (!ticked.length || pub.busy) return;
    pub.run({ intent: 'publish', keys: ticked });
  }, [ticked, pub]);
  // ⌘Enter (Ctrl+Enter) publishes what is ticked, from anywhere on the board but a field or a sheet.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      if (!window.matchMedia('(min-width: 1024px)').matches) return;
      e.preventDefault();
      publish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, publish]);
  const results = answer?.ok ? (answer.results as { status: string }[] | undefined) : undefined;
  const failed = results?.filter((r) => r.status === 'failed').length ?? 0;
  const published = results?.filter((r) => r.status === 'published').length ?? 0;
  const toggle = (key: string) =>
    setUnticked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  return (
    <ColumnShell
      column="staged"
      total={total}
      hidden={hidden}
      actions={
        canEdit && cards.length ? (
          <Button
            size="sm"
            className="max-lg:hidden"
            disabled={!ticked.length || pub.busy}
            onClick={publish}
          >
            {pub.busy ? 'Publishing…' : `Publish ${ticked.length}`}
          </Button>
        ) : null
      }
    >
      {results || refusal(answer) ? (
        <p role="status" className="mx-4 mb-2 rounded-xl bg-muted/50 px-3 py-2 text-xs">
          {refusal(answer) ??
            `Published ${published}.${failed ? ` ${failed} didn’t; they stay here with why.` : ''}`}
        </p>
      ) : null}
      {canEdit && cards.length ? (
        <p className="px-4 pb-1 text-muted-foreground text-xs lg:hidden">
          Publishing is on a larger screen.
        </p>
      ) : null}
      {cards.length ? (
        <ul className="flex flex-col gap-0.5 px-1.5">
          {cards.map((c) => (
            <CardRow
              key={c.key}
              card={c}
              canEdit={canEdit}
              flip
              tick={canEdit ? { on: !unticked.has(c.key), toggle: () => toggle(c.key) } : undefined}
            />
          ))}
        </ul>
      ) : (
        <Empty>
          Nothing staged. Accepted drafts and edits wait here until someone publishes them.
        </Empty>
      )}
      {more.cursor ? <ShowMore more={more} /> : null}
    </ColumnShell>
  );
}

/**
 * One product on the board. The whole card opens its sheet; Enter does too, D drafts a gap card,
 * A accepts a drafted card's drafts and X ticks a staged one.
 */
function CardRow({
  card: c,
  canEdit,
  flip,
  state,
  tick,
}: {
  card: BoardCard;
  canEdit: boolean;
  flip: boolean;
  state?: Batch['rows'][string];
  tick?: { on: boolean; toggle: () => void };
}) {
  const act = useCatalogAction();
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  next.set('product', c.key);
  const href = `?${next}`;
  const canDraft = canEdit && c.column === 'gaps' && draftable(c);
  const canAccept = canEdit && c.column === 'drafted' && c.drafts > 0;
  const error = refusal(act.answer) ?? (typeof state === 'object' ? state.error : null);
  const busy = act.busy || state === 'running';
  const keys = [canDraft && 'D', canAccept && 'A', tick && 'X'].filter(Boolean).join(' ');
  const draft = () => act.run({ intent: 'draft', key: c.key });
  const accept = () => act.run({ intent: 'accept', key: c.key });
  return (
    <Item
      asChild
      size="xs"
      className="relative flex-nowrap items-start px-2.5 py-2 hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring/50"
    >
      <li
        data-card={c.key}
        data-flip={flip ? c.key : undefined}
        aria-busy={busy || undefined}
        onKeyDown={(e) => {
          // The card's link has focus; Enter follows it on its own.
          if (!(e.target instanceof HTMLAnchorElement) || e.metaKey || e.ctrlKey || e.altKey)
            return;
          const k = e.key.toLowerCase();
          if (k === 'd' && canDraft && !busy && window.matchMedia('(min-width: 1024px)').matches) {
            e.preventDefault();
            draft();
          } else if (k === 'a' && canAccept && !busy) {
            e.preventDefault();
            accept();
          } else if (k === 'x' && tick) {
            e.preventDefault();
            tick.toggle();
          }
        }}
      >
        {tick ? (
          <ItemMedia className="mt-0.5 self-start max-lg:hidden">
            <input
              type="checkbox"
              checked={tick.on}
              onChange={tick.toggle}
              aria-label={`Publish ${c.title}`}
              className="hit-area relative z-10 size-4 shrink-0"
            />
          </ItemMedia>
        ) : null}
        <ItemContent className="min-w-0 gap-0">
          <ItemTitle className="w-full">
            <Link
              to={href}
              preventScrollReset
              data-card-link
              aria-keyshortcuts={keys || undefined}
              className="block min-w-0 truncate outline-none after:absolute after:inset-0 after:rounded-2xl"
            >
              {c.title}
            </Link>
          </ItemTitle>
          <span className="block truncate font-mono text-2xs text-muted-foreground">{c.key}</span>
          <ItemDescription
            className={cn(
              'mt-0.5 text-xs',
              c.failure && c.column === 'staged' ? 'text-bad' : 'text-muted-foreground',
            )}
          >
            {c.column === 'drafted' ? (
              <span
                aria-hidden="true"
                className="mr-1.5 inline-block size-1.5 rounded-full bg-ai align-middle"
              />
            ) : null}
            {cardReason(c)}
            {c.column === 'published' ? (
              <>
                {' '}
                <Ago ms={c.at} />
                {missingText(c) ? ` · still missing ${missingText(c)}` : ''}
              </>
            ) : null}
            {(c.column === 'gaps' || c.column === 'published') && c.locales.length ? (
              <span className="whitespace-nowrap">
                {' in '}
                <span className="font-mono">{c.locales.join(' ')}</span>
              </span>
            ) : null}
            {c.column === 'gaps' && (c.drafts || c.staged) ? (
              <span className="text-muted-foreground">
                {c.drafts ? ` · ${c.drafts} drafted` : ''}
                {c.staged ? ` · ${c.staged} staged` : ''}
              </span>
            ) : null}
          </ItemDescription>
          {state === 'running' || (act.busy && !error) ? (
            <p className="mt-0.5 text-ai text-xs" role="status">
              Drafting…
            </p>
          ) : error ? (
            <p className="mt-0.5 text-bad text-xs" role="alert">
              {error}
            </p>
          ) : null}
        </ItemContent>
        {canDraft ? (
          <ItemActions className="max-lg:hidden">
            <Button
              size="xs"
              variant="ghost"
              className="relative z-10 shrink-0 opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100 touch:opacity-100"
              disabled={busy}
              onClick={draft}
              aria-label={`Draft the missing text of ${c.title}`}
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-ai" />
              Draft
            </Button>
          </ItemActions>
        ) : canAccept ? (
          <ItemActions>
            <Button
              size="xs"
              variant="outline"
              className="relative z-10 shrink-0"
              disabled={busy}
              onClick={accept}
              aria-label={`Accept the drafts of ${c.title}`}
            >
              Accept
            </Button>
          </ItemActions>
        ) : null}
      </li>
    </Item>
  );
}

/** J and K (or the arrows) move between the board's cards in reading order; J from the page starts. */
function useBoardKeys(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      const dir = k === 'j' || k === 'ArrowDown' ? 1 : k === 'k' || k === 'ArrowUp' ? -1 : 0;
      if (!dir || !root.current || !pageShortcut(e)) return;
      const cards = [...root.current.querySelectorAll<HTMLElement>('a[data-card-link]')].filter(
        (el) => el.offsetParent !== null,
      );
      const at = cards.indexOf(document.activeElement as HTMLElement);
      // Arrows scroll the page unless a card has focus.
      if (at === -1 && (k === 'ArrowDown' || k === 'ArrowUp')) return;
      const next = cards[at === -1 ? 0 : at + dir];
      if (next) {
        e.preventDefault();
        next.focus();
        next.closest('li')?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [root]);
}

/**
 * Cards glide to where the board puts them after a change (a draft lands in Drafted, a publish
 * empties Staged): each card is measured before and after, keyed by product, and moved from its
 * old place in 200ms on an exponential ease-out. Reduced motion moves them at once.
 */
function useFlip(root: RefObject<HTMLDivElement | null>, dep: unknown) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, { x: number; y: number }>();
    for (const card of el.querySelectorAll<HTMLElement>('[data-flip]')) {
      const key = card.dataset.flip;
      if (!key || next.has(key) || card.offsetParent === null) continue;
      const r = card.getBoundingClientRect();
      const at = { x: r.left + window.scrollX, y: r.top + window.scrollY };
      next.set(key, at);
      const was = last.current.get(key);
      if (still || !was) continue;
      const dx = was.x - at.x;
      const dy = was.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      card.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
        duration: MOTION.move,
        easing: EASE.arrive,
      });
    }
    last.current = next;
  }, [dep]);
}
