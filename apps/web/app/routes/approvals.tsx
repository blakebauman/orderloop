import { ORDER_MODEL_LABELS, type OrderModel, type OrderState } from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
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
import { humanize, money, orderRef } from '~/lib/format';
import { listApprovals } from '~/lib/orders.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/approvals';

export const meta = () => [{ title: 'Approvals · OrderLoop' }];

const FILTERS = ['pending', 'approved', 'rejected', 'escalated', 'all'] as const;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  const rows = await listApprovals(status);
  // Pending rows carry the reason and escalation clock from each order's live state.
  const open = rows.filter((r) => r.status === 'pending').slice(0, 25);
  const states = await Promise.all(
    open.map((r) =>
      engine()
        .snapshot(r.orderId)
        .catch(() => null),
    ),
  );
  const context: Record<string, ApprovalContext> = {};
  open.forEach((r, i) => {
    const s = states[i] as OrderState | null;
    if (s) context[r.id] = approvalContext(s, r.nodeId);
  });
  // Most urgent first: the soonest escalation, then the oldest request.
  if (status === 'pending')
    rows.sort(
      (a, b) =>
        (context[a.id]?.deadline ?? Number.POSITIVE_INFINITY) -
          (context[b.id]?.deadline ?? Number.POSITIVE_INFINITY) || a.requestedAt - b.requestedAt,
    );
  return { status, rows, context };
}

type Item = Awaited<ReturnType<typeof listApprovals>>[number];
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
      return [...kept, ...rows.filter((r) => !known.has(r.id)).map((r) => ({ r }))];
    });
  }, [rows, status]);
  return shown;
}

export default function Approvals() {
  const { rows, status, context } = useLoaderData<typeof loader>();
  const shown = useStableRows(rows, status);
  // J or K from anywhere on the page (outside fields) starts the keyboard path at the first row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const el = document.activeElement;
      if (el && el !== document.body && !el.closest('header, nav')) return;
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
          <fieldset className="flex rounded-md border bg-card p-0.5 text-[13px]">
            <legend className="sr-only">Show approvals</legend>
            {FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setParams({ status: s })}
                className={cn(
                  'rounded-[4px] px-2.5 py-2 sm:py-1',
                  status === s
                    ? 'bg-primary font-medium text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {humanize(s)}
              </button>
            ))}
          </fieldset>
        }
      />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        {shown.length ? (
          <>
            {status === 'pending' ? (
              <p className="mb-3 hidden text-muted-foreground text-xs sm:block">
                Keyboard: <kbd className="font-mono">J</kbd>/<kbd className="font-mono">K</kbd> move
                between rows, <kbd className="font-mono">A</kbd> approve,{' '}
                <kbd className="font-mono">R</kbd> reject, <kbd className="font-mono">Z</kbd> undo.
              </p>
            ) : null}
            {/* J / K (or arrows) move between open rows; the rows themselves take A / R / Z. */}
            <ul
              className="divide-y rounded-md border bg-card"
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
                  onHold={hold}
                  gone={!!gone}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="rounded-md border bg-card">
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
                  : `No ${status} approvals.`}
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
  onHold,
  gone,
}: {
  r: Item;
  ctx?: ApprovalContext;
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
  const open = r.status === 'pending' && !decided && !gone;
  const orderName =
    r.orderTitle || (r.orderModel ? ORDER_MODEL_LABELS[r.orderModel as OrderModel] : '');
  return (
    <li
      ref={ref}
      tabIndex={open || gone ? 0 : undefined}
      aria-labelledby={titleId}
      aria-describedby={ctx?.reason ? reasonId : undefined}
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
          <span className="ml-auto font-semibold tabular sm:hidden">
            {money(r.amount, r.currency ?? undefined)}
          </span>
        </div>
        {open && ctx ? (
          <div id={reasonId}>
            <DecisionContext ctx={ctx} className="mt-1.5" />
          </div>
        ) : ctx?.reason ? (
          <p id={reasonId} className="mt-1.5 text-muted-foreground text-sm">
            {ctx.reason}
          </p>
        ) : null}
        <p className="mt-1 text-muted-foreground text-xs">
          {ctx?.step ? `${ctx.step} · ` : ''}
          for {humanize(r.assignee) || 'anyone'} · requested <Ago ms={r.requestedAt} />
          {r.decidedBy ? ` · ${r.status} by ${r.decidedBy}` : ''}
          {r.note ? ` · “${r.note}”` : ''}
        </p>
        {fetcher.data?.error ? (
          <p className="mt-1.5 text-bad text-sm" role="alert">
            {fetcher.data.error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <span className="hidden font-semibold tabular sm:block">
          {money(r.amount, r.currency ?? undefined)}
        </span>
        {open && canApprove ? (
          <DecisionControls
            compact
            shortcuts={ref}
            onPendingChange={onHold}
            onFlush={(decision, note) => sendDecision(r.orderId, r.nodeId, decision, note)}
            busy={fetcher.state !== 'idle'}
            onDecide={(decision, note) => {
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
            Decision recorded, see the order <ArrowRight className="size-3.5" />
          </Link>
        ) : gone ? (
          <div className="flex flex-col items-start gap-1 sm:items-end" role="status">
            {ctx?.deadline && ctx.deadline <= Date.now() ? (
              <>
                <ApprovalBadge status="escalated" />
                <span className="text-muted-foreground text-xs">
                  {ctx.onTimeout ? `No decision in time: ${ctx.onTimeout}` : 'No decision in time'}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground text-xs">Decided elsewhere</span>
            )}
            <Link to={`/orders/${r.orderId}`} className="text-link text-xs hover:underline">
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
