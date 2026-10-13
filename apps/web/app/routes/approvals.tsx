import { ORDER_TYPE_LABELS, type OrderState, type OrderType } from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { DecisionContext, DecisionControls, sendDecision } from '~/components/decision';
import { Empty, PageHeader } from '~/components/page';
import { ApprovalBadge } from '~/components/status';
import { type ApprovalContext, approvalContext } from '~/lib/approvals';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ago, humanize, money, orderRef } from '~/lib/format';
import { listApprovals } from '~/lib/orders.server';
import type { Route } from './+types/approvals';

export const meta = () => [{ title: 'Approvals · Order Loop' }];

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

export default function Approvals() {
  const { rows, status, context } = useLoaderData<typeof loader>();
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
        {rows.length ? (
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
              {rows.map((r) => (
                <Row key={r.id} r={r} ctx={context[r.id]} onHold={hold} />
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
  ctx,
  onHold,
}: {
  r: Awaited<ReturnType<typeof listApprovals>>[number];
  ctx?: ApprovalContext;
  onHold: (on: boolean) => void;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const ref = useRef<HTMLLIElement>(null);
  const decided = fetcher.data?.ok;
  const open = r.status === 'pending' && !decided;
  const orderName =
    r.orderTitle || (r.orderType ? ORDER_TYPE_LABELS[r.orderType as OrderType] : '');
  return (
    <li
      ref={ref}
      tabIndex={open ? 0 : undefined}
      className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link to={`/orders/${r.orderId}`} className="font-medium hover:underline">
            {orderName}
          </Link>
          <span className="font-mono font-normal text-muted-foreground text-xs">
            {orderRef(r.orderId)}
          </span>
          <span className="text-muted-foreground text-sm">
            {r.customerName ?? r.customerId ?? 'No customer'}
          </span>
          <span className="ml-auto font-semibold tabular sm:hidden">{money(r.amount)}</span>
        </div>
        {open && ctx ? <DecisionContext ctx={ctx} className="mt-1.5" /> : null}
        <p className="mt-1 text-muted-foreground text-xs">
          For {humanize(r.assignee) || 'anyone'} · requested {ago(r.requestedAt)}
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
        <span className="hidden font-semibold tabular sm:block">{money(r.amount)}</span>
        {open ? (
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
        ) : (
          <ApprovalBadge status={r.status} />
        )}
      </div>
    </li>
  );
}
