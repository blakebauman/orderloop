import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  toBase,
} from '@orderloop/core';
import { ArrowRight, ChevronRight, Play } from 'lucide-react';
import { useEffect, useId } from 'react';
import { Form, Link, useLoaderData, useNavigation, useRevalidator } from 'react-router';
import { Ago, WaitingAt } from '~/components/ago';
import { DecisionContext, lockAt } from '~/components/decision';
import { Empty, PageHeader, Section } from '~/components/page';
import { Performance } from '~/components/performance';
import { StatusBadge } from '~/components/status';
import { type ApprovalContext, approvalContext } from '~/lib/approvals';
import { GROUP_HREF, GROUP_LABEL, type Lane, lanes as laneList } from '~/lib/attention';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded } from '~/lib/flows.server';
import { duration, humanize, money, orderRef, orderStatus, STATUS_COLOR } from '~/lib/format';
import { performance } from '~/lib/metrics.server';
import {
  attentionSummary,
  customerNames,
  dashboardStats,
  declinedCount,
  declinedOrderIds,
  demoAvailable,
  listApprovals,
  listOrders,
} from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import { startScenario } from '~/lib/scenarios.server';
import { useDateTime } from '~/lib/use-date-time';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import type { Route } from './+types/dashboard';

export const meta = () => [{ title: 'Overview · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  await ensureSeeded();
  const [stats, recent, approvals, attention, declinedTotal, perf, demo] = await Promise.all([
    dashboardStats(),
    listOrders({ sort: 'updated' }, 8),
    listApprovals('pending'),
    attentionSummary(),
    declinedCount(),
    performance(),
    demoAvailable(),
  ]);
  const [names, declinedSet] = await Promise.all([
    customerNames(recent.map((o) => o.customerId)),
    declinedOrderIds(recent.map((o) => o.id)),
  ]);
  const declined = [...declinedSet];
  const top = approvals.slice(0, 5);
  const states = await Promise.all(
    top.map((a) =>
      engine()
        .snapshot(a.orderId)
        .catch(() => null),
    ),
  );
  const decisions = top.map((a, i) => ({
    ...a,
    ctx: states[i]
      ? approvalContext(states[i] as OrderState, a.nodeId)
      : ({ facts: [], trail: [] } as ApprovalContext),
  }));
  return {
    stats,
    perf,
    recent,
    names,
    declined,
    declinedTotal,
    demo,
    decisions,
    moreDecisions: Math.max(0, approvals.length - top.length),
    failed: attention.failed,
    failedTotal: attention.failedTotal,
    lanes: laneList(attention.waits),
    // When this was read, for the header's "Updated" line.
    at: Date.now(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  return startScenario(request, me, String((await request.formData()).get('scenario') ?? ''));
}

/** How often the overview refreshes while it is in view. */
const REFRESH_MS = 15_000;

export default function Dashboard() {
  const {
    stats,
    perf,
    recent,
    names,
    declined,
    declinedTotal,
    decisions,
    moreDecisions,
    failed,
    failedTotal,
    lanes,
    demo,
    at,
  } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const canOperate = useCan('operator');
  const formatTime = useDateTime();
  const { revalidate, state: refreshing } = useRevalidator();
  // Kept current while in view: every few seconds, and as soon as the tab comes back.
  useEffect(() => {
    const visible = () => document.visibilityState === 'visible';
    const t = window.setInterval(() => {
      if (visible()) revalidate();
    }, REFRESH_MS);
    const onShow = () => {
      if (visible()) revalidate();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [revalidate]);
  const count = (s: string[]) =>
    stats.byStatus.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  const completedValue = stats.byStatus.find((r) => r.status === 'completed')?.total ?? 0;
  // The status register in three groups, so the strip reads as open work, good endings and the
  // rest rather than seven equal figures.
  const groups: {
    label: string;
    cols: string;
    rows: { label: string; n: number; status: string; note?: string }[];
  }[] = [
    {
      label: 'Open',
      cols: 'grid-cols-2',
      rows: [
        { label: 'In flight', n: count(['queued', 'running']), status: 'running' },
        { label: 'Waiting', n: count(['waiting']), status: 'waiting' },
      ],
    },
    {
      label: 'Ended well',
      cols: 'grid-cols-1',
      rows: [
        {
          label: 'Completed',
          n: count(['completed']),
          status: 'completed',
          note: money(completedValue, BASE_CURRENCY),
        },
      ],
    },
    {
      label: 'Ended otherwise',
      cols: 'grid-cols-2 sm:grid-cols-4',
      rows: [
        { label: 'Failed', n: count(['failed']), status: 'failed' },
        { label: 'Rolled back', n: count(['rolled_back']), status: 'rolled_back' },
        // Older policy declines were stored as cancelled; count them where they belong.
        { label: 'Declined', n: count(['declined']) + declinedTotal, status: 'declined' },
        { label: 'Cancelled', n: count(['cancelled']) - declinedTotal, status: 'cancelled' },
      ],
    },
  ];
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            Where every order stands, and what needs you.{' '}
            <span className="whitespace-nowrap" suppressHydrationWarning>
              {refreshing === 'loading' ? 'Updating…' : `Updated ${formatTime(at)}`}
            </span>
          </>
        }
      />
      <div className="mx-auto max-w-[1400px] space-y-6 px-4 pb-10 sm:px-6">
        {/* The status register, over every order: each figure opens the matching orders. */}
        <nav aria-label="All orders by status">
          <p className="caption mb-1.5">All orders</p>
          <div className="grid gap-x-4 gap-y-3 lg:grid-cols-[2fr_1fr_4fr]">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label} className="min-w-0">
                <h2 className="mb-1.5 text-muted-foreground text-xs">{g.label}</h2>
                <div
                  className={`grid ${g.cols} gap-px overflow-hidden rounded-md border bg-[var(--rule)]`}
                >
                  {g.rows.map((r) => (
                    <Link
                      key={r.status}
                      to={`/orders?status=${r.status}`}
                      aria-label={`${r.label}: ${r.n} ${r.n === 1 ? 'order' : 'orders'}${r.note ? `, ${r.note}` : ''}`}
                      className="min-w-0 bg-card px-4 py-2.5 hover:bg-muted"
                    >
                      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full"
                          style={{
                            background: STATUS_COLOR[r.status as keyof typeof STATUS_COLOR],
                          }}
                        />
                        {r.label}
                      </span>
                      <span className="mt-0.5 flex items-baseline gap-2">
                        <span className="font-medium text-lg tabular">{r.n}</span>
                        {r.note ? (
                          <span className="truncate text-muted-foreground text-xs tabular">
                            {r.note}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </nav>

        {/* Phones read decisions, then what needs attention, then recent orders; wide screens put
            what needs attention in the rail beside the other two. */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div className="min-w-0 lg:col-start-1">
            {decisions.length ? (
              <Section
                title={
                  <span className="flex items-center gap-2">
                    Needs a decision
                    <span className="rounded-sm bg-wait/15 px-1.5 py-px font-medium text-[11px] text-wait tabular">
                      {decisions.length + moreDecisions}
                    </span>
                  </span>
                }
                actions={
                  <Link to="/approvals" className="text-link text-xs hover:underline">
                    Open the queue
                  </Link>
                }
                flush
              >
                <ul className="divide-y">
                  {decisions.map((d) => (
                    <DecisionCard key={d.id} d={d} />
                  ))}
                  {moreDecisions ? (
                    <li className="px-4 py-2.5 text-sm">
                      <Link to="/approvals" className="text-link hover:underline">
                        {moreDecisions} more in the queue
                      </Link>
                    </li>
                  ) : null}
                </ul>
              </Section>
            ) : (
              <p className="flex items-center gap-2 rounded-md border bg-card px-4 py-2.5 text-muted-foreground text-sm">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-idle" />
                Nothing is waiting on a decision.
                <Link
                  to="/approvals?status=all"
                  className="ml-auto text-link text-xs hover:underline"
                >
                  Past approvals
                </Link>
              </p>
            )}
          </div>

          <aside className="min-w-0 space-y-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <NeedsAttention failed={failed} failedTotal={failedTotal} lanes={lanes} />

            {canOperate && demo ? (
              <details className="group rounded-md border bg-card">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5">
                  <span className="section-title">Demo scenarios</span>
                  <ChevronRight
                    className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                </summary>
                <div className="space-y-0.5 border-t p-2">
                  {SCENARIOS.map((s) => (
                    <Form method="post" key={s.id}>
                      <input type="hidden" name="scenario" value={s.id} />
                      <button
                        type="submit"
                        disabled={nav.state !== 'idle'}
                        className="group/s flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
                      >
                        <Play
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-sm">{s.label}</span>
                          <span className="block text-muted-foreground text-xs leading-snug">
                            {s.blurb}
                          </span>
                        </span>
                        <ArrowRight
                          className="mt-0.5 size-3.5 opacity-0 transition group-hover/s:opacity-60"
                          aria-hidden="true"
                        />
                      </button>
                    </Form>
                  ))}
                  <Link
                    to="/orders/scenarios"
                    className="block px-2 pt-1.5 pb-1 text-link text-sm hover:underline"
                  >
                    See what each one fails on, or edit one first
                  </Link>
                </div>
              </details>
            ) : null}
          </aside>

          <div className="min-w-0 lg:col-start-1">
            <Section
              title="Recently updated"
              actions={
                <Link to="/orders?sort=updated" className="text-link text-xs hover:underline">
                  All orders
                </Link>
              }
              flush
            >
              {recent.length ? (
                <ul className="divide-y">
                  {recent.map((o) => (
                    <RecentRow
                      key={o.id}
                      o={o}
                      customer={(o.customerId && names[o.customerId]) || o.customerId}
                      status={orderStatus(o.status, o.id, declined)}
                    />
                  ))}
                </ul>
              ) : (
                <Empty
                  action={
                    <Link to="/orders/new" className="text-link text-sm hover:underline">
                      Start an order
                    </Link>
                  }
                >
                  No orders yet.
                </Empty>
              )}
            </Section>
          </div>
        </div>

        <Performance p={perf} />
      </div>
    </>
  );
}

type Data = Awaited<ReturnType<typeof loader>>;

/** "€392.42", with its base-currency figure when it differs. */
function Amount({
  amount,
  currency,
  fxRate,
}: {
  amount: number | null;
  currency: string | null | undefined;
  fxRate?: number | null;
}) {
  const own = currency ?? BASE_CURRENCY;
  return (
    <span className="block text-right tabular">
      {money(amount, own)}
      {own !== BASE_CURRENCY && amount !== null ? (
        <span className="block text-muted-foreground text-xs">
          {money(toBase(amount, fxRate ?? 1), BASE_CURRENCY)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One approval waiting on a person. The card opens the order; its link is named by the order, and
 * the reason, figures and clock describe it. When the decision window closes it says so in place.
 */
function DecisionCard({ d }: { d: Data['decisions'][number] }) {
  const titleId = useId();
  const detailId = useId();
  const deadline = d.ctx.deadline;
  const now = useNow(deadline ? 1000 : null);
  const closed = deadline !== undefined && lockAt(deadline) <= now;
  const name =
    d.orderTitle || (d.orderModel ? ORDER_MODEL_LABELS[d.orderModel as OrderModel] : 'Order');
  return (
    <li
      className={`relative flex items-start gap-3 px-4 py-3 hover:bg-muted/40 ${closed ? 'opacity-70' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link
            id={titleId}
            to={`/orders/${d.orderId}`}
            aria-describedby={detailId}
            className="font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
          >
            {name}{' '}
            <span className="font-mono font-normal text-muted-foreground text-xs">
              {orderRef(d.orderId)}
            </span>
          </Link>
          <span className="text-muted-foreground text-sm">{d.customerName ?? d.customerId}</span>
        </div>
        <div id={detailId}>
          <DecisionContext ctx={d.ctx} clock={!closed} className="mt-1" />
          {closed ? (
            <p className="mt-1 font-medium text-sm text-wait">
              Decisions closed
              {d.ctx.onTimeout ? `; it goes to ${d.ctx.onTimeout}` : ''}.
            </p>
          ) : null}
          <p className="mt-1 text-muted-foreground text-xs">
            Assigned to {humanize(d.assignee) || 'any approver'} · requested{' '}
            <Ago ms={d.requestedAt} />
          </p>
        </div>
      </div>
      <span className="font-semibold">
        <Amount amount={d.amount} currency={d.currency} fxRate={d.fxRate} />
      </span>
      <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </li>
  );
}

/** One recently updated order: named by its title and ref, described by the rest. */
function RecentRow({
  o,
  customer,
  status,
}: {
  o: Data['recent'][number];
  customer: string | null;
  status: string;
}) {
  const detailId = useId();
  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
      <span className="order-3 col-span-2 sm:order-none sm:col-span-1">
        <StatusBadge status={status} />
      </span>
      <span className="min-w-0">
        <Link
          to={`/orders/${o.id}`}
          aria-describedby={detailId}
          className="block truncate font-medium text-sm after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
        >
          {o.title || o.externalId || ORDER_MODEL_LABELS[o.model as OrderModel]}{' '}
          <span className="font-mono font-normal text-muted-foreground text-xs">
            {orderRef(o.id)}
          </span>
        </Link>
        <span id={detailId} className="block truncate text-muted-foreground text-xs">
          {customer || (o.contactEmail ? `Guest · ${o.contactEmail}` : 'No customer')} ·{' '}
          {ORDER_MODEL_LABELS[o.model as OrderModel]}
          {o.waitingOn || o.waitingAt ? (
            <>
              {' · '}
              <WaitingAt prefix at={o.waitingAt} since={o.waitingSince} on={o.waitingOn} />
            </>
          ) : o.stoppedAt ? (
            ` · stopped at ${o.stoppedAt}`
          ) : null}
        </span>
      </span>
      <span className="text-sm">
        <Amount amount={o.total} currency={o.currency} fxRate={o.fxRate} />
        <span className="block text-right text-muted-foreground text-xs">
          <Ago ms={o.updatedAt} />
        </span>
      </span>
    </li>
  );
}

/**
 * What needs a person, beside the decisions: orders that failed or rolled back, with where and why,
 * then every open wait by who it is on, with the oldest. Each opens where it is dealt with.
 */
function NeedsAttention({
  failed,
  failedTotal,
  lanes,
}: {
  failed: Data['failed'];
  failedTotal: number;
  lanes: Lane[];
}) {
  const now = useNow(30_000);
  const groups = (['people', 'outside', 'timers', 'unknown'] as const)
    .map((g) => ({ g, items: lanes.filter((l) => l.group === g) }))
    .filter((x) => x.items.length);
  return (
    <Section
      title="Needs attention"
      actions={
        <Link to="/orders?attention=1" className="text-link text-xs hover:underline">
          In Orders
        </Link>
      }
      flush
    >
      {failed.length ? (
        <div className="border-b">
          <h3 className="px-4 pt-2.5 pb-1 text-muted-foreground text-xs">
            Ended badly: {failedTotal}
          </h3>
          <ul>
            {failed.map((o) => (
              <li key={o.id} className="relative px-4 py-1.5 hover:bg-muted/40">
                <div className="flex items-baseline gap-2">
                  <Link
                    to={`/orders/${o.id}`}
                    className="min-w-0 flex-1 truncate text-sm after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                  >
                    {o.title || ORDER_MODEL_LABELS[o.model as OrderModel]}{' '}
                    <span className="font-mono text-muted-foreground text-xs">
                      {orderRef(o.id)}
                    </span>
                  </Link>
                  <StatusBadge status={o.status} />
                </div>
                {o.stoppedAt || o.reason ? (
                  <p
                    className="truncate text-muted-foreground text-xs"
                    title={o.reason ?? undefined}
                  >
                    {[o.stoppedAt, o.reason].filter(Boolean).join(': ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {failedTotal > failed.length ? (
            <Link
              to="/orders?attention=1"
              className="block px-4 pt-1 pb-2.5 text-link text-xs hover:underline"
            >
              {failedTotal - failed.length} more
            </Link>
          ) : (
            <div className="pb-1.5" />
          )}
        </div>
      ) : null}
      {groups.length ? (
        groups.map(({ g, items }) => (
          <div key={g} className="border-b last:border-b-0">
            <h3 className="px-4 pt-2.5 pb-1 text-muted-foreground text-xs">
              Waiting {GROUP_LABEL[g].toLowerCase()}
            </h3>
            <ul className="pb-1.5">
              {items.map((l) => (
                <li key={`${l.step}-${l.on}`} className="relative px-4 py-1.5 hover:bg-muted/40">
                  <div className="flex items-baseline gap-3 text-sm">
                    <Link
                      to={GROUP_HREF[g]}
                      className="min-w-0 flex-1 truncate after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                    >
                      {l.step}
                    </Link>
                    <span className="font-medium tabular">{l.n}</span>
                  </div>
                  <p className="truncate text-muted-foreground text-xs">
                    {l.on && l.on.toLowerCase() !== l.step.toLowerCase() ? `on ${l.on}` : null}
                    {l.on && l.on.toLowerCase() !== l.step.toLowerCase() && l.oldest ? ' · ' : null}
                    {l.oldest ? `oldest ${duration(Math.max(0, now - l.oldest))}` : null}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : failed.length ? null : (
        <Empty>Nothing needs attention: no order has failed, and none is waiting.</Empty>
      )}
    </Section>
  );
}
