import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  ownOrderRefusal,
  toBase,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { ArrowRight, Check, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { Ago } from '~/components/ago';
import {
  type Decision,
  DecisionContext,
  DecisionControls,
  DecisionDeadline,
  type DecisionHandle,
  sendDecision,
} from '~/components/decision';
import { Empty, PageHeader } from '~/components/page';
import { ApprovalBadge } from '~/components/status';
import {
  type ApprovalContext,
  type ApprovalGroup,
  batchProgress,
  byUrgency,
  cannotSelect,
  groupApprovals,
  groupName,
  lockAt,
  rowContext,
} from '~/lib/approvals';
import { requireUser } from '~/lib/auth.server';
import { decodeCursor, encodeCursor } from '~/lib/cursor';
import { engine } from '~/lib/env.server';
import { assigneeLabel, count, money, orderRef, outcomeLabel, plural, until } from '~/lib/format';
import { listApprovals, pendingApprovalCounts } from '~/lib/orders.server';
import { approvalSeparation } from '~/lib/settings.server';
import { pageShortcut } from '~/lib/shortcuts';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import type { Route } from './+types/approvals';

export const meta = () => [{ title: 'Approvals · OrderLoop' }];

const FILTERS = ['pending', 'approved', 'rejected', 'escalated', 'all'] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const params = new URL(request.url).searchParams;
  const status = params.get('status') ?? 'pending';
  // The pending queue holds only what a decision can resume; approvals on recorded orders (no run
  // behind them) are their own list, folded into one line under the queue.
  const recorded = status === 'pending' && params.get('recorded') === '1';
  const scope = status !== 'pending' ? undefined : recorded ? 'recorded' : 'live';
  // Pages are keyed by their last row; the cursor is the orders list's, read as request time + id.
  const cursor = decodeCursor(params.get('after'));
  const after = cursor ? { requestedAt: cursor.createdAt, id: cursor.id } : null;
  const [page, separate, pending] = await Promise.all([
    listApprovals(status, after, undefined, scope),
    approvalSeparation(),
    status === 'pending' ? pendingApprovalCounts() : null,
  ]);
  const { rows } = page;
  // Each row on the page carries the reason, figures and escalation clock from its order's live
  // state: one read per order, at most a page's worth. A run that isn't there (null) is a fact
  // about the order; a read that failed says nothing, so that row keeps its buttons.
  const states = new Map(
    await Promise.all(
      [...new Set(rows.map((r) => r.orderId))].map(
        async (id) =>
          [
            id,
            (await engine()
              .snapshot(id)
              .catch(() => undefined)) as OrderState | null | undefined,
          ] as const,
      ),
    ),
  );
  const context: Record<string, ApprovalContext> = {};
  // Orders with no live run: their approvals can't be decided from here.
  const noRun: Record<string, true> = {};
  // Said before anyone acts, not after the undo window: who may not decide which rows.
  const refused: Record<string, string> = {};
  for (const r of rows) {
    const s = states.get(r.orderId);
    if (s === null) noRun[r.orderId] = true;
    context[r.id] = rowContext(s, r);
    const why = r.status === 'pending' ? ownOrderRefusal(separate, r.startedBy, me.id) : null;
    if (why) refused[r.id] = why;
  }
  // Most urgent first within the page: the soonest escalation, then the oldest request.
  if (status === 'pending') byUrgency(rows, context, noRun);
  return {
    status,
    recorded,
    /** Pending approvals on recorded orders, for the queue's folded line. */
    undecidable: pending?.recorded ?? 0,
    // Who started each order stays on the server; the page only needs `refused`.
    rows: rows.map(({ startedBy: _, total: __, ...r }) => r),
    context,
    refused,
    noRun,
    total: page.total,
    from: page.from,
    paged: !!after,
    next: page.next ? encodeCursor({ createdAt: page.next.requestedAt, id: page.next.id }) : null,
  };
}

type Item = Omit<Awaited<ReturnType<typeof listApprovals>>['rows'][number], 'startedBy' | 'total'>;
type Shown = { r: Item; gone?: number };
type Result = { ok: boolean; error?: string };

/**
 * Rows hold their place: a pending approval that leaves the queue (escalated, or decided elsewhere)
 * stays for a minute marked as resolved instead of vanishing under the reader; new ones join at the
 * end rather than reshuffling the list.
 */
function useStableRows(rows: Item[], status: string, view: string) {
  const [shown, setShown] = useState<Shown[]>(() => rows.map((r) => ({ r })));
  const lastView = useRef(view);
  useEffect(() => {
    setShown((prev) => {
      // Another filter or page starts afresh; only a refresh of the same page holds rows in place.
      if (status !== 'pending' || lastView.current !== view) {
        lastView.current = view;
        return rows.map((r) => ({ r }));
      }
      const now = Date.now();
      const fresh = new Map(rows.map((r) => [r.id, r]));
      const kept = prev
        .map((p): Shown => {
          const r = fresh.get(p.r.id);
          return r ? { r } : { r: p.r, gone: p.gone ?? now };
        })
        .filter((p) => !p.gone || now - p.gone < 60_000);
      const known = new Set(prev.map((p) => p.r.id));
      const added = rows.filter((r) => !known.has(r.id));
      // The next approval on the same order (an escalation, or the next sign-off) takes the place
      // of the one it follows, so an order is never listed twice.
      const placed = kept.map((p) => {
        if (!p.gone) return p;
        const next = added.find((r) => r.orderId === p.r.orderId);
        if (!next) return p;
        added.splice(added.indexOf(next), 1);
        return { r: next };
      });
      return [...placed, ...added.map((r) => ({ r }))];
    });
  }, [rows, status, view]);
  return shown;
}

/** Adds or removes `id` from a set held in state, returning the same set when nothing changes. */
const toggled = (set: ReadonlySet<string>, id: string, on: boolean) => {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

/** Moves focus to the next row the keyboard path can stop at, after `from`. */
function focusNextRow(from: HTMLElement) {
  const all = [
    ...(from.closest('[data-queue]')?.querySelectorAll<HTMLElement>('li[tabindex="0"]') ?? []),
  ];
  all[all.indexOf(from) + 1]?.focus();
}

/** Re-renders once at `at` (epoch ms), if it is finite. */
function useWakeAt(at: number | undefined) {
  const [, wake] = useState(0);
  useEffect(() => {
    if (at === undefined || !Number.isFinite(at)) return;
    // Clamped: a timer longer than 2^31 - 1 ms would fire at once.
    const t = window.setTimeout(
      () => wake((n) => n + 1),
      Math.min(Math.max(0, at - Date.now()) + 50, 2 ** 31 - 1),
    );
    return () => window.clearTimeout(t);
  }, [at]);
}

/** What every row and group on the page reports to, and reads back. */
type Tracking = {
  /** Rows with a decision in its undo window. */
  held: ReadonlySet<string>;
  /** Rows whose decision has been sent. */
  sent: ReadonlySet<string>;
  /** What the order said back to each sent decision. */
  results: Readonly<Record<string, Result>>;
  onHold: (id: string, on: boolean) => void;
  onSent: (id: string) => void;
  onResult: (id: string, result: Result) => void;
};

export default function Approvals() {
  const { rows, status, recorded, undecidable, context, refused, noRun, total, from, paged, next } =
    useLoaderData<typeof loader>();
  const canApprove = useCan('approver');
  const [params, setParams] = useSearchParams();
  const shown = useStableRows(
    rows,
    status,
    `${status}:${recorded ? 'recorded' : ''}:${params.get('after') ?? ''}`,
  );
  // The last context seen for each row, so one that has left the queue keeps its group and can
  // still say what it was about.
  const seen = useRef<Record<string, ApprovalContext>>({});
  Object.assign(seen.current, context);
  const ctxs = seen.current;
  // Base for this list's pages and "first page": the recorded list keeps its own scope.
  const base = `?status=${encodeURIComponent(status)}${recorded ? '&recorded=1' : ''}`;
  const pending = status === 'pending';

  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const [results, setResults] = useState<Record<string, Result>>({});
  const onHold = useCallback((id: string, on: boolean) => setHeld((s) => toggled(s, id, on)), []);
  const onSent = useCallback((id: string) => setSent((s) => toggled(s, id, true)), []);
  const onResult = useCallback(
    (id: string, result: Result) => setResults((m) => ({ ...m, [id]: result })),
    [],
  );
  const tracking: Tracking = { held, sent, results, onHold, onSent, onResult };

  // A row whose decisions have closed leaves the queue: nobody can act on it, and the engine is
  // about to take its timeout branch. One that is held or sent stays, so its decision can land.
  // Re-render when the next one closes rather than every second: the rows tick their own clocks.
  const now = Date.now();
  useWakeAt(
    pending
      ? Math.min(
          ...shown.map(({ r }) => {
            const d = ctxs[r.id]?.deadline;
            return d !== undefined && lockAt(d) > now ? lockAt(d) : Number.POSITIVE_INFINITY;
          }),
        )
      : undefined,
  );
  const past = (r: Item) => {
    const d = ctxs[r.id]?.deadline;
    return pending && d !== undefined && lockAt(d) <= now && !held.has(r.id) && !sent.has(r.id);
  };
  const queue = shown.filter(({ r }) => !past(r));
  // Gone ones whose time ran out are done waiting; they simply drop off.
  const closed = shown.filter(({ r, gone }) => !gone && r.status === 'pending' && past(r));
  const groups = pending
    ? groupApprovals(
        queue.map((s) => s.r),
        ctxs,
      )
    : [];
  const byId = new Map(queue.map((s) => [s.r.id, s]));
  // Whether each row can join its group's batch: the same refusals its own buttons keep. A row
  // that is resolved has nothing to say about it ('').
  const why: Record<string, string | null> = {};
  for (const { r, gone } of queue) {
    const d = ctxs[r.id]?.deadline;
    why[r.id] =
      gone || r.status !== 'pending'
        ? ''
        : cannotSelect({
            canApprove,
            refused: refused[r.id],
            noRun: !!noRun[r.orderId],
            closed: d !== undefined && lockAt(d) <= now,
            decided: held.has(r.id) || sent.has(r.id) || !!results[r.id]?.ok,
          });
  }

  const anyOpen = queue.some(
    ({ r, gone }) => !gone && r.status === 'pending' && !refused[r.id] && !noRun[r.orderId],
  );
  const anyBatch = groups.some((g) => g.ids.length > 1);

  // J or K from anywhere on the page (outside fields) starts the keyboard path at the first row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'j' && e.key !== 'k') || !pageShortcut(e)) return;
      const el = document.activeElement;
      // Clicking the page focuses <main> (it takes focus for the skip link); that counts as the page.
      if (el && el !== document.body && el.tagName !== 'MAIN' && !el.closest('header, nav')) return;
      const first = document.querySelector<HTMLElement>('main li[tabindex="0"]');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // J / K (or the arrows) move between open rows, across groups.
  const queueRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = queueRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox';
      if (typing || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      const k = e.key;
      const dir = k === 'j' || k === 'ArrowDown' ? 1 : k === 'k' || k === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      const all = [...el.querySelectorAll<HTMLElement>('li[tabindex="0"]')];
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('li[tabindex="0"]');
      const at = row ? all.indexOf(row) : -1;
      const to = all[at === -1 ? 0 : at + dir];
      if (to) {
        e.preventDefault();
        to.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  });
  const { revalidate } = useRevalidator();
  // Rows must not move under someone mid-decision: hold the refresh while any undo window is open.
  const holding = useRef(0);
  holding.current = held.size;
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!holding.current) revalidate();
    }, 5000);
    return () => window.clearInterval(t);
  }, [revalidate]);

  const rowProps = (s: Shown, group?: ApprovalGroup) => ({
    r: s.r,
    ctx: ctxs[s.r.id],
    group,
    refused: refused[s.r.id],
    noRun: !!noRun[s.r.orderId],
    gone: !!s.gone,
    tracking,
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Decisions people owe running orders, grouped by the rule that asked, most urgent first. A decision resumes the order where it stopped."
        actions={
          <Segmented
            aria-label="Show approvals"
            value={status}
            onValueChange={(s) => setParams({ status: s })}
          >
            {FILTERS.map((s) => (
              <SegmentedItem key={s} value={s}>
                {outcomeLabel(s)}
              </SegmentedItem>
            ))}
          </Segmented>
        }
      />
      <div className="mx-auto max-w-page px-4 pb-10 sm:px-6">
        {recorded ? (
          <p className="mb-3 flex max-w-[75ch] flex-wrap items-baseline gap-x-3 gap-y-1 text-muted-foreground text-sm">
            <span>
              Approvals on recorded orders. These orders have no run behind them, so a decision here
              would have nothing to resume.
            </span>
            <Link to="?status=pending" className="hit-area text-link hover:underline">
              Back to the queue
            </Link>
          </p>
        ) : null}
        {queue.length ? (
          <>
            {anyOpen && !canApprove ? (
              <p className="mb-3 text-muted-foreground text-sm">
                You can see what is waiting; people with the approver role decide.
              </p>
            ) : anyOpen ? (
              <p className="mb-3 hidden text-muted-foreground text-xs fine:block">
                Keyboard: <kbd className="font-mono">J</kbd> and <kbd className="font-mono">K</kbd>{' '}
                move between rows, <kbd className="font-mono">A</kbd> approves,{' '}
                <kbd className="font-mono">R</kbd> rejects, <kbd className="font-mono">Z</kbd>{' '}
                undoes
                {anyBatch ? (
                  <>
                    , <kbd className="font-mono">X</kbd> selects a row for its group’s batch
                  </>
                ) : null}
                .
              </p>
            ) : null}
            {/* J / K (or arrows) move between open rows across groups; rows take A / R / Z / X. */}
            <div ref={queueRef} data-queue className={pending ? 'space-y-4' : undefined}>
              {pending ? (
                groups.map((g) => (
                  <Group key={g.key} g={g} canApprove={canApprove} why={why} tracking={tracking}>
                    {(select) =>
                      g.ids.map((id) => {
                        const s = byId.get(id)!;
                        return <Row key={id} {...rowProps(s, g)} select={select(s)} />;
                      })
                    }
                  </Group>
                ))
              ) : (
                <ul className="divide-y card overflow-hidden">
                  {queue.map((s) => (
                    <Row key={s.r.id} {...rowProps(s)} />
                  ))}
                </ul>
              )}
            </div>
            <Pages
              base={base}
              total={total}
              from={from}
              shown={rows.length}
              paged={paged}
              next={next}
            />
          </>
        ) : (
          <div className="card overflow-hidden">
            <Empty
              action={
                paged ? (
                  <Link to={base} className="text-link text-sm hover:underline">
                    Back to the first page
                  </Link>
                ) : status !== 'all' ? (
                  <button
                    type="button"
                    className="text-link text-sm hover:underline"
                    onClick={() => setParams({ status: 'all' })}
                  >
                    Show all approvals
                  </button>
                ) : null
              }
            >
              {paged
                ? 'Nothing is left on this page.'
                : recorded
                  ? 'No approvals are waiting on recorded orders.'
                  : status === 'pending'
                    ? 'Nothing is waiting on a decision.'
                    : status === 'all'
                      ? 'No approvals yet. Orders ask for one when a flow reaches an approval step.'
                      : `No approvals ${outcomeLabel(status).toLowerCase()}.`}
            </Empty>
          </div>
        )}
        {closed.length ? <ClosedLine items={closed} ctxs={ctxs} /> : null}
        {status === 'pending' && !recorded && undecidable ? <RecordedLine n={undecidable} /> : null}
      </div>
    </>
  );
}

/** How a row takes part in its group's batch: a checkbox, why it can't, or neither. */
type Select =
  | { on: boolean; toggle: () => void; handle: (h: DecisionHandle | null) => void }
  | { why: string; handle: (h: DecisionHandle | null) => void }
  | { handle: (h: DecisionHandle | null) => void };

/**
 * Approvals that share a flow, a step and the rule that fired: said once in the header, with the
 * count and the soonest deadline, so the rows only say what differs. With two or more rows a person
 * can decide, rows can be selected and decided together; a batch never reaches past its group, and
 * is each selected row's own held decision, each with its own undo, plus Undo all while any is held.
 */
function Group({
  g,
  canApprove,
  why,
  tracking,
  children,
}: {
  g: ApprovalGroup;
  canApprove: boolean;
  /** Per row: null when it can join a batch, else why not ('' for a row with nothing to say). */
  why: Record<string, string | null>;
  tracking: Tracking;
  children: (select: (s: Shown) => Select) => React.ReactNode;
}) {
  const { held, sent, results } = tracking;
  const headingId = useId();
  const name = groupName(g);
  const handles = useRef(new Map<string, DecisionHandle>());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [batch, setBatch] = useState<{ decision: Decision; ids: string[]; ends: number } | null>(
    null,
  );
  const [said, setSaid] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const now = useNow(batch ? 250 : null);

  const selectable = g.ids.filter((id) => why[id] === null);
  const batching = canApprove && selectable.length + (batch?.ids.length ?? 0) > 1;
  const chosen = selectable.filter((id) => selected.has(id));

  // A batch's rows count as held until they report it: the report lands a render after the batch.
  const everHeld = useRef(new Set<string>());
  for (const id of held) everHeld.current.add(id);
  const progress = batch
    ? batchProgress(
        batch.decision,
        batch.ids.map((id) => ({
          held: held.has(id) || (!everHeld.current.has(id) && !sent.has(id)),
          sent: sent.has(id),
          result: results[id],
        })),
      )
    : null;
  const done = progress?.phase === 'done';
  const message = progress?.message;
  useEffect(() => {
    if (!done) return;
    setSaid(message ?? '');
    setBatch(null);
  }, [done, message]);
  // Undo all leaves with the last held decision; keep focus in this group, not on the page.
  const holdingBatch = progress?.phase === 'holding';
  const wasHolding = useRef(false);
  const undoAllButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!wasHolding.current && holdingBatch) undoAllButton.current?.focus();
    if (wasHolding.current && !holdingBatch) {
      const at = document.activeElement;
      if (!at || at === document.body) headingRef.current?.focus();
    }
    wasHolding.current = holdingBatch;
  }, [holdingBatch]);

  const start = (decision: Decision) => {
    let ends = 0;
    const ids = chosen.filter((id) => {
      const at = handles.current.get(id)?.decide(decision, { quiet: true });
      if (at == null) return false;
      ends = Math.max(ends, at);
      return true;
    });
    setSelected(new Set());
    if (!ids.length) return;
    for (const id of ids) everHeld.current.delete(id);
    setBatch({ decision, ids, ends });
    setSaid(
      `${decision === 'approved' ? 'Approving' : 'Rejecting'} ${plural(ids.length, 'approval')}. Undo all takes them back.`,
    );
  };
  const undoAll = () => {
    for (const id of batch?.ids ?? []) handles.current.get(id)?.undo();
  };
  // Z (or Escape) in the header takes the whole batch back while any of it is held.
  const undoAllRef = useRef(undoAll);
  undoAllRef.current = undoAll;
  useEffect(() => {
    const el = barRef.current;
    if (!el || !holdingBatch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'z' || e.key === 'Escape') {
        e.preventDefault();
        undoAllRef.current();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [holdingBatch]);

  const select = (s: Shown): Select => {
    const id = s.r.id;
    const handle = (h: DecisionHandle | null) => {
      if (h) handles.current.set(id, h);
      else handles.current.delete(id);
    };
    if (!batching) return { handle };
    const not = why[id];
    if (not !== null) return not ? { why: not, handle } : { handle };
    return {
      on: selected.has(id),
      toggle: () => setSelected((x) => toggled(x, id, !x.has(id))),
      handle,
    };
  };

  const allOn = chosen.length > 0 && chosen.length === selectable.length;
  const someOn = chosen.length > 0 && !allOn;
  const left = batch ? Math.max(0, Math.ceil((batch.ends - now) / 1000)) : 0;

  return (
    <section aria-labelledby={headingId} className="card overflow-hidden">
      <div ref={barRef} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        {batching && !batch ? (
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = someOn;
            }}
            onChange={() => setSelected(allOn ? new Set() : new Set(selectable))}
            aria-label={`Select all in this group: ${name}`}
            disabled={!selectable.length}
            className="hit-area relative size-4 shrink-0 accent-foreground"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="section-title outline-none">
            {name}
          </h2>
          <p className="text-muted-foreground text-xs">
            {plural(g.ids.length, 'approval')}
            {g.soonest !== undefined && lockAt(g.soonest) > Date.now() ? (
              <>
                {' · first closes '}
                <SoonestClose deadline={g.soonest} />
              </>
            ) : null}
            {g.title ? <> · all for “{g.title}”</> : null}
          </p>
        </div>
        {progress?.phase === 'holding' && batch ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {batch.decision === 'approved' ? 'Approving' : 'Rejecting'} {progress.held} in{' '}
              <span className="tabular">{left}s</span>
            </span>
            <Button
              ref={undoAllButton}
              size="sm"
              variant="outline"
              onClick={undoAll}
              aria-keyshortcuts="Z"
            >
              Undo all
            </Button>
          </div>
        ) : progress?.phase === 'sending' ? (
          <span className="text-muted-foreground text-sm">Recording decisions…</span>
        ) : chosen.length ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{chosen.length} selected</span>
            <Button size="sm" onClick={() => start('approved')}>
              <Check aria-hidden="true" /> Approve selected
            </Button>
            <Button size="sm" variant="outline" onClick={() => start('rejected')}>
              <X aria-hidden="true" /> Reject selected
            </Button>
          </div>
        ) : batching ? (
          <span className="hidden text-muted-foreground text-xs sm:inline">
            Select rows to decide them together
          </span>
        ) : null}
        {/* Said once per batch: when it starts and when it is done, never per row. */}
        <p className="sr-only" aria-live="polite">
          {said}
        </p>
      </div>
      <ul className="divide-y">{children(select)}</ul>
    </section>
  );
}

/** "in 3m" or "2:05 PM", for a group header's soonest deadline. */
function SoonestClose({ deadline }: { deadline: number }) {
  const now = useNow(1000);
  const lock = lockAt(deadline);
  return (
    <span className="tabular" suppressHydrationWarning>
      {until(lock, now)}
    </span>
  );
}

/**
 * Approvals whose decisions have closed: the step is about to time out and the engine will take its
 * timeout branch. Folded into one line, not listed with buttons nobody can press.
 */
function ClosedLine({ items, ctxs }: { items: Shown[]; ctxs: Record<string, ApprovalContext> }) {
  return (
    <details className="group mt-3 text-muted-foreground text-sm">
      <summary className="hit-area inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {plural(items.length, 'approval')} closed, waiting for the engine
      </summary>
      <ul className="mt-2 space-y-1 pl-5">
        {items.map(({ r }) => {
          const ctx = ctxs[r.id];
          return (
            <li key={r.id}>
              <Link to={`/orders/${r.orderId}`} className="font-mono hover:underline">
                {orderRef(r.orderId)}
              </Link>{' '}
              · {r.customerName ?? r.customerId ?? 'No customer'} ·{' '}
              <span className="tabular">{money(r.amount, r.currency ?? undefined)}</span>
              {ctx?.step ? ` · ${ctx.step}` : ''}
              {ctx?.onTimeout ? `; going to ${ctx.onTimeout}` : '; timing out'}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * Approvals on recorded orders (no run behind them, so nothing a decision could resume), folded
 * into one line under the queue rather than listed as rows nobody can act on.
 */
function RecordedLine({ n }: { n: number }) {
  return (
    <p className="mt-3 flex max-w-[75ch] flex-wrap items-baseline gap-x-3 gap-y-1 text-muted-foreground text-sm">
      <span>
        {n === 1
          ? '1 approval on a recorded order can’t be decided here: the order has no run to resume.'
          : `${plural(n, 'approval')} on recorded orders can’t be decided here: those orders have no run to resume.`}
      </span>
      <Link
        to="?status=pending&recorded=1"
        className="hit-area inline-flex items-center gap-1 text-link hover:underline"
      >
        Show {n === 1 ? 'it' : 'them'} <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </p>
  );
}

/**
 * Where this page sits in the list, and the way on. Pages are keyed by their last row, so the way
 * back is to the first page rather than one page back.
 */
function Pages({
  base,
  total,
  from,
  shown,
  paged,
  next,
}: {
  /** This list's own address, without a page. */
  base: string;
  total: number;
  from: number;
  shown: number;
  paged: boolean;
  next: string | null;
}) {
  if (!paged && !next) return null;
  return (
    <nav
      aria-label="Pages"
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-sm"
    >
      <span className="tabular">
        {count(from + 1)}–{count(from + shown)} of {count(total)}
      </span>
      <span className="ml-auto flex items-center gap-4">
        {paged ? (
          <Link to={base} className="hit-area text-link hover:underline">
            First page
          </Link>
        ) : null}
        {next ? (
          <Link
            to={`${base}&after=${encodeURIComponent(next)}`}
            className="hit-area inline-flex items-center gap-1 text-link hover:underline"
          >
            Next page <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </span>
    </nav>
  );
}

function Row({
  r,
  ctx,
  group,
  refused,
  noRun,
  gone,
  tracking,
  select,
}: {
  r: Item;
  ctx?: ApprovalContext;
  /** The group it's listed in (pending only): what the row needn't repeat. */
  group?: ApprovalGroup;
  /** Why this person may not decide it (separation of duties), said before they try. */
  refused?: string;
  /** The order has no live run, so a decision here would have nothing to resume. */
  noRun?: boolean;
  /** No longer in the pending queue (escalated or decided elsewhere); kept in place briefly. */
  gone?: boolean;
  tracking: Tracking;
  /** Its part in the group's batch. */
  select?: Select;
}) {
  const canApprove = useCan('approver');
  const fetcher = useFetcher<Result>();
  const ref = useRef<HTMLLIElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const decided = fetcher.data?.ok;
  const [made, setMade] = useState<Decision | null>(null);
  const open = r.status === 'pending' && !decided && !gone;
  // Only an open row the engine can resume takes part in the keyboard path.
  const decidable = open && !noRun;
  const orderName =
    r.orderTitle || (r.orderModel ? ORDER_MODEL_LABELS[r.orderModel as OrderModel] : '');
  const amount = money(r.amount, r.currency ?? undefined);
  const inBase =
    r.currency && r.currency !== BASE_CURRENCY && r.amount !== null
      ? money(toBase(r.amount, r.fxRate ?? 1), BASE_CURRENCY)
      : null;
  // In a group the header says the rule; the row says its reason only when it adds to that
  // ("Over credit limit by $2,332" under "Over credit limit").
  const reason = group && ctx?.reason === group.rule ? undefined : ctx?.reason;
  const { onHold, onSent, onResult } = tracking;
  const hold = useCallback((on: boolean) => onHold(r.id, on), [onHold, r.id]);
  // A refused decision comes back after focus moved on: bring it back to the row that says why.
  const error = fetcher.data?.error;
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) onResult(r.id, fetcher.data);
  }, [fetcher.state, fetcher.data, onResult, r.id]);
  const tick = select && 'on' in select ? select : null;
  // X (or Space on the row itself) ticks it for the group's batch.
  useEffect(() => {
    const el = ref.current;
    if (!el || !tick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox';
      if (typing) return;
      if (e.key.toLowerCase() === 'x' || (e.key === ' ' && e.target === el)) {
        e.preventDefault();
        tick.toggle();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [tick]);
  const meta = (
    <p className="mt-1 text-muted-foreground text-xs">
      {ctx?.step ? `${ctx.step} · assigned to` : 'Assigned to'}{' '}
      {assigneeLabel(r.assignee) || 'any approver'} · requested <Ago ms={r.requestedAt} />
      {r.status === 'escalated'
        ? ` · nobody decided in time${ctx?.onTimeout ? `, so it went to ${ctx.onTimeout}` : ''}`
        : r.decidedBy
          ? ` · ${r.status} by ${r.decidedBy}`
          : ''}
    </p>
  );
  return (
    <li
      ref={ref}
      tabIndex={decidable || gone ? 0 : undefined}
      aria-labelledby={titleId}
      aria-describedby={reason ? reasonId : undefined}
      aria-keyshortcuts={decidable && !refused ? (tick ? 'A R Z X' : 'A R Z') : undefined}
      className={cn('flex items-start gap-3 px-4 py-3', gone && 'bg-muted/40')}
    >
      {select && ('on' in select || 'why' in select) ? (
        tick ? (
          <input
            type="checkbox"
            checked={tick.on}
            onChange={tick.toggle}
            aria-label={`Select ${orderRef(r.orderId)}, ${amount}`}
            className="hit-area relative mt-0.5 size-4 shrink-0 accent-foreground"
          />
        ) : (
          // Holds the column, so rows that can't be ticked still line up with those that can.
          <span className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )
      ) : null}
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <p id={titleId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {group && open && ctx?.deadline !== undefined ? (
              <DecisionDeadline
                deadline={ctx.deadline}
                onTimeout={ctx.onTimeout}
                className="text-sm"
              />
            ) : null}
            {group ? (
              <Link
                to={`/orders/${r.orderId}`}
                className="font-medium font-mono text-sm hover:underline"
              >
                {orderRef(r.orderId)}
              </Link>
            ) : (
              <>
                <Link to={`/orders/${r.orderId}`} className="font-medium hover:underline">
                  {orderName}
                </Link>
                <span className="font-mono font-normal text-muted-foreground text-xs">
                  {orderRef(r.orderId)}
                </span>
              </>
            )}
            <span className="text-sm">{r.customerName ?? r.customerId ?? 'No customer'}</span>
            {group && !group.title && orderName ? (
              <span className="min-w-0 truncate text-muted-foreground text-sm">{orderName}</span>
            ) : null}
            {group ? (
              <span className="text-muted-foreground text-xs">
                <Ago ms={r.requestedAt} />
              </span>
            ) : null}
            {/* In the row's name for screen readers everywhere; shown here on phones only. */}
            <span className="ml-auto font-semibold tabular sm:sr-only">
              {amount}
              {inBase ? (
                <span className="font-normal text-muted-foreground"> ({inBase})</span>
              ) : null}
            </span>
          </p>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
            {reason ? (
              <p id={reasonId} className="min-w-0 truncate font-medium text-sm" title={reason}>
                {reason}
              </p>
            ) : null}
            {group ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded((x) => !x)}
                className="hit-area inline-flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform motion-reduce:transition-none',
                    expanded && 'rotate-90',
                  )}
                  aria-hidden="true"
                />
                Details
              </button>
            ) : null}
          </div>
          {group ? (
            <div id={detailsId} hidden={!expanded}>
              {ctx ? (
                <DecisionContext ctx={ctx} clock={open} reason={false} className="mt-1" />
              ) : null}
              {meta}
            </div>
          ) : (
            <>
              {ctx ? (
                <DecisionContext ctx={ctx} clock={false} reason={false} className="mt-1" />
              ) : null}
              {meta}
            </>
          )}
          {r.note ? (
            <p className="mt-1 max-w-[72ch] text-sm">
              <span className="text-muted-foreground">Note: </span>
              {r.note}
            </p>
          ) : null}
          {error ? (
            <p className="mt-1.5 text-bad text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <span aria-hidden="true" className="hidden text-right font-semibold tabular sm:block">
            {amount}
            {inBase ? (
              <span className="block font-normal text-muted-foreground text-xs">{inBase}</span>
            ) : null}
          </span>
          {open && noRun ? (
            <div className="flex max-w-64 flex-col items-start gap-1 sm:items-end">
              <p className="text-muted-foreground text-sm sm:text-right">
                No live run for this order, so it can’t be decided here.
              </p>
              <Link
                to={`/orders/${r.orderId}`}
                className="hit-area inline-flex items-center gap-1 text-link text-sm hover:underline"
              >
                Open the order <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          ) : open && canApprove && refused ? (
            <p className="max-w-64 text-muted-foreground text-sm sm:text-right">{refused}</p>
          ) : open && canApprove ? (
            <DecisionControls
              compact
              withNote={expanded}
              handle={select?.handle}
              deadline={ctx?.deadline}
              onTimeout={ctx?.onTimeout}
              shortcuts={ref}
              onPendingChange={hold}
              onFlush={(decision, note) => sendDecision(r.orderId, r.nodeId, decision, note)}
              busy={fetcher.state !== 'idle'}
              label={`${orderRef(r.orderId)}, ${amount}`}
              onDecide={(decision, note) => {
                setMade(decision);
                onSent(r.id);
                // Keep the keyboard flow going: the next open row takes focus.
                if (ref.current?.contains(document.activeElement)) focusNextRow(ref.current);
                fetcher.submit(
                  {
                    intent: decision === 'approved' ? 'approve' : 'reject',
                    nodeId: r.nodeId,
                    note,
                  },
                  { method: 'post', action: `/orders/${r.orderId}/action` },
                );
              }}
            />
          ) : decided ? (
            <Link
              to={`/orders/${r.orderId}`}
              className="inline-flex items-center gap-1 text-link text-sm hover:underline"
            >
              {made === 'rejected' ? 'Rejected' : 'Approved'}; the order goes on. See it{' '}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : gone ? (
            <div className="flex flex-col items-start gap-1 sm:items-end" role="status">
              {ctx?.deadline && ctx.deadline <= Date.now() ? (
                <>
                  <ApprovalBadge status="escalated" />
                  <span className="text-muted-foreground text-xs">
                    {ctx.onTimeout
                      ? `No decision in time; it went to ${ctx.onTimeout}`
                      : 'No decision in time'}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground text-xs">Decided elsewhere</span>
              )}
              <Link
                to={`/orders/${r.orderId}`}
                className="hit-area text-link text-xs hover:underline"
              >
                See what happened
              </Link>
            </div>
          ) : (
            <ApprovalBadge status={r.status} />
          )}
        </div>
      </div>
    </li>
  );
}
