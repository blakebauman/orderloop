import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  ownOrderRefusal,
  toBase,
} from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { Ago } from '~/components/ago';
import { DecisionContext, DecisionControls, sendDecision } from '~/components/decision';
import { Empty, PageHeader } from '~/components/page';
import { ApprovalBadge } from '~/components/status';
import { type ApprovalContext, approvalContext } from '~/lib/approvals';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { humanize, money, orderRef, outcomeLabel } from '~/lib/format';
import { listApprovals } from '~/lib/orders.server';
import { approvalSeparation } from '~/lib/settings.server';
import { pageShortcut } from '~/lib/shortcuts';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/approvals';

export const meta = () => [{ title: 'Approvals · OrderLoop' }];

const FILTERS = ['pending', 'approved', 'rejected', 'escalated', 'all'] as const;

/** Orders whose live state is read for context, pending ones first. */
const CONTEXT_ORDERS = 60;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  const [rows, separate] = await Promise.all([listApprovals(status), approvalSeparation()]);
  // Each row carries the reason, figures and escalation clock from its order's live state; the
  // pending queue comes first, then decided rows, so history says what it was about too.
  const ids = [
    ...new Set(
      [...rows]
        .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))
        .map((r) => r.orderId),
    ),
  ].slice(0, CONTEXT_ORDERS);
  const states = new Map(
    await Promise.all(
      ids.map(
        async (id) =>
          [
            id,
            (await engine()
              .snapshot(id)
              .catch(() => null)) as OrderState | null,
          ] as const,
      ),
    ),
  );
  const context: Record<string, ApprovalContext> = {};
  // Said before anyone acts, not after the undo window: who may not decide which rows.
  const refused: Record<string, string> = {};
  for (const r of rows) {
    const s = states.get(r.orderId);
    if (s) context[r.id] = approvalContext(s, r.nodeId);
    const why = r.status === 'pending' ? ownOrderRefusal(separate, r.startedBy, me.id) : null;
    if (why) refused[r.id] = why;
  }
  // Most urgent first: the soonest escalation, then the oldest request.
  if (status === 'pending')
    rows.sort(
      (a, b) =>
        (context[a.id]?.deadline ?? Number.POSITIVE_INFINITY) -
          (context[b.id]?.deadline ?? Number.POSITIVE_INFINITY) || a.requestedAt - b.requestedAt,
    );
  // Who started each order stays on the server; the page only needs `refused`.
  return { status, rows: rows.map(({ startedBy: _, ...r }) => r), context, refused };
}

type Item = Omit<Awaited<ReturnType<typeof listApprovals>>[number], 'startedBy'>;
type Shown = { r: Item; gone?: number };

/**
 * Rows hold their place: a pending approval that leaves the queue (escalated, or decided elsewhere)
 * stays for a minute marked as resolved instead of vanishing under the reader; new ones join at the
 * end rather than reshuffling the list.
 */
function useStableRows(rows: Item[], status: string) {
  const [shown, setShown] = useState<Shown[]>(() => rows.map((r) => ({ r })));
  const lastStatus = useRef(status);
  useEffect(() => {
    setShown((prev) => {
      if (status !== 'pending' || lastStatus.current !== status) {
        lastStatus.current = status;
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
  }, [rows, status]);
  return shown;
}

export default function Approvals() {
  const { rows, status, context, refused } = useLoaderData<typeof loader>();
  const canApprove = useCan('approver');
  const anyOpen = rows.some((r) => r.status === 'pending' && !refused[r.id]);
  const shown = useStableRows(rows, status);
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
  const [, setParams] = useSearchParams();
  const { revalidate } = useRevalidator();
  // Rows must not move under someone mid-decision: hold the refresh while any undo window is open.
  const holds = useRef(0);
  const hold = useCallback((on: boolean) => {
    holds.current = Math.max(0, holds.current + (on ? 1 : -1));
  }, []);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!holds.current) revalidate();
    }, 5000);
    return () => window.clearInterval(t);
  }, [revalidate]);
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Decisions people owe running orders, most urgent first. A decision resumes the order where it stopped."
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
        {shown.length ? (
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
                undoes.
              </p>
            ) : null}
            {/* J / K (or arrows) move between open rows; the rows themselves take A / R / Z. */}
            <ul
              className="divide-y card overflow-hidden"
              onKeyDown={(e) => {
                if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
                const k = e.key;
                const dir =
                  k === 'j' || k === 'ArrowDown' ? 1 : k === 'k' || k === 'ArrowUp' ? -1 : 0;
                if (!dir) return;
                const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('li[tabindex="0"]')];
                const at = rows.indexOf(document.activeElement as HTMLElement);
                const next = rows[at === -1 ? 0 : at + dir];
                if (next) {
                  e.preventDefault();
                  next.focus();
                }
              }}
            >
              {shown.map(({ r, gone }) => (
                <Row
                  key={r.id}
                  r={r}
                  ctx={context[r.id] ?? undefined}
                  refused={refused[r.id]}
                  onHold={hold}
                  gone={!!gone}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="card overflow-hidden">
            <Empty
              action={
                status !== 'all' ? (
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
              {status === 'pending'
                ? 'Nothing is waiting on a decision.'
                : status === 'all'
                  ? 'No approvals yet. Orders ask for one when a flow reaches an approval step.'
                  : `No approvals ${outcomeLabel(status).toLowerCase()}.`}
            </Empty>
          </div>
        )}
      </div>
    </>
  );
}

function Row({
  r,
  ctx: liveCtx,
  refused,
  onHold,
  gone,
}: {
  r: Item;
  ctx?: ApprovalContext;
  /** Why this person may not decide it (separation of duties), said before they try. */
  refused?: string;
  onHold: (on: boolean) => void;
  /** No longer in the pending queue (escalated or decided elsewhere); kept in place briefly. */
  gone?: boolean;
}) {
  const canApprove = useCan('approver');
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const ref = useRef<HTMLLIElement>(null);
  const titleId = useId();
  const reasonId = useId();
  // Keep the last context we saw, so a resolved row can still say what it was about.
  const seen = useRef(liveCtx);
  if (liveCtx) seen.current = liveCtx;
  const ctx = seen.current;
  const decided = fetcher.data?.ok;
  const [made, setMade] = useState<'approved' | 'rejected' | null>(null);
  const open = r.status === 'pending' && !decided && !gone;
  const orderName =
    r.orderTitle || (r.orderModel ? ORDER_MODEL_LABELS[r.orderModel as OrderModel] : '');
  const amount = money(r.amount, r.currency ?? undefined);
  const inBase =
    r.currency && r.currency !== BASE_CURRENCY && r.amount !== null
      ? money(toBase(r.amount, r.fxRate ?? 1), BASE_CURRENCY)
      : null;
  // A refused decision comes back after focus moved on: bring it back to the row that says why.
  const error = fetcher.data?.error;
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  return (
    <li
      ref={ref}
      tabIndex={open || gone ? 0 : undefined}
      aria-labelledby={titleId}
      aria-describedby={ctx?.reason ? reasonId : undefined}
      aria-keyshortcuts={open && !refused ? 'A R Z' : undefined}
      className={cn(
        'grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start',
        gone && 'bg-muted/40',
      )}
    >
      <div className="min-w-0">
        <div id={titleId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link to={`/orders/${r.orderId}`} className="font-medium hover:underline">
            {orderName}
          </Link>
          <span className="font-mono font-normal text-muted-foreground text-xs">
            {orderRef(r.orderId)}
          </span>
          <span className="text-muted-foreground text-sm">
            {r.customerName ?? r.customerId ?? 'No customer'}
          </span>
          {/* In the row's name for screen readers everywhere; shown here on phones only. */}
          <span className="ml-auto font-semibold tabular sm:sr-only">
            {amount}
            {inBase ? <span className="font-normal text-muted-foreground"> ({inBase})</span> : null}
          </span>
        </div>
        {ctx ? (
          <div id={reasonId}>
            <DecisionContext ctx={ctx} clock={open} className="mt-1.5" />
          </div>
        ) : null}
        <p className="mt-1 text-muted-foreground text-xs">
          {ctx?.step ? `${ctx.step} · ` : ''}
          assigned to {humanize(r.assignee) || 'any approver'} · requested{' '}
          <Ago ms={r.requestedAt} />
          {r.status === 'escalated'
            ? ` · nobody decided in time${ctx?.onTimeout ? `, so it went to ${ctx.onTimeout}` : ''}`
            : r.decidedBy
              ? ` · ${r.status} by ${r.decidedBy}`
              : ''}
        </p>
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
        {open && canApprove && refused ? (
          <p className="max-w-64 text-muted-foreground text-sm sm:text-right">{refused}</p>
        ) : open && canApprove ? (
          <DecisionControls
            compact
            deadline={ctx?.deadline}
            onTimeout={ctx?.onTimeout}
            shortcuts={ref}
            onPendingChange={onHold}
            onFlush={(decision, note) => sendDecision(r.orderId, r.nodeId, decision, note)}
            busy={fetcher.state !== 'idle'}
            label={`${orderRef(r.orderId)}, ${amount}`}
            onDecide={(decision, note) => {
              setMade(decision);
              // Keep the keyboard flow going: the next open row takes focus.
              if (ref.current?.contains(document.activeElement)) {
                let next = ref.current.nextElementSibling as HTMLElement | null;
                while (next && next.getAttribute('tabindex') !== '0')
                  next = next.nextElementSibling as HTMLElement | null;
                next?.focus();
              }
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
    </li>
  );
}
