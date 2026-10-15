import { ORDER_MODEL_LABELS, type OrderModel, type OrderState } from '@orderloop/core';
import { ArrowRight, ChevronRight, Play } from 'lucide-react';
import { Form, Link, redirect, useLoaderData, useNavigation } from 'react-router';
import { Ago, WaitingAt } from '~/components/ago';
import { DecisionContext } from '~/components/decision';
import { Empty, PageHeader, Section } from '~/components/page';
import { Performance } from '~/components/performance';
import { StatusBadge } from '~/components/status';
import { type ApprovalContext, approvalContext } from '~/lib/approvals';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded } from '~/lib/flows.server';
import { humanize, money, orderRef, orderStatus, STATUS_COLOR, waitLabel } from '~/lib/format';
import { performance } from '~/lib/metrics.server';
import {
  customerNames,
  dashboardStats,
  declinedCount,
  declinedOrderIds,
  demoAvailable,
  listApprovals,
  listOrders,
  waitingOrders,
} from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/dashboard';

export const meta = () => [{ title: 'Overview · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  await ensureSeeded();
  const [stats, recent, approvals, waiting, declinedTotal, perf, demo] = await Promise.all([
    dashboardStats(),
    listOrders({ sort: 'updated' }, 10),
    listApprovals('pending'),
    waitingOrders(),
    declinedCount(),
    performance(),
    demoAvailable(),
  ]);
  const [names, declinedSet] = await Promise.all([
    customerNames([...recent, ...waiting].map((o) => o.customerId)),
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
      : ({ facts: [] } as ApprovalContext),
  }));
  // Where orders are piling up: open waits grouped by what they wait on.
  const lanes = new Map<string, number>();
  for (const o of waiting) {
    for (const w of (o.waitingOn ?? '').split(' · ').map(waitLabel).filter(Boolean))
      lanes.set(w, (lanes.get(w) ?? 0) + 1);
  }
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
    lanes: [...lanes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const form = await request.formData();
  const sc = SCENARIOS.find((s) => s.id === form.get('scenario'));
  if (!sc || !(await demoAvailable()))
    return { error: 'That demo scenario no longer exists. Reload the page.' };
  await ensureSeeded();
  const { orderId } = await engine().startOrder({
    flowId: sc.flowId,
    input: sc.input,
    startedBy: me.id,
  });
  return redirect(`/orders/${orderId}`);
}

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
    lanes,
    demo,
  } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const canOperate = useCan('operator');
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
          note: money(completedValue),
        },
      ],
    },
    {
      label: 'Ended otherwise',
      cols: 'grid-cols-2 sm:grid-cols-4',
      rows: [
        // Older policy declines were stored as cancelled; count them where they belong.
        { label: 'Declined', n: count(['declined']) + declinedTotal, status: 'declined' },
        { label: 'Rolled back', n: count(['rolled_back']), status: 'rolled_back' },
        { label: 'Failed', n: count(['failed']), status: 'failed' },
        { label: 'Cancelled', n: count(['cancelled']) - declinedTotal, status: 'cancelled' },
      ],
    },
  ];
  return (
    <>
      <PageHeader title="Overview" subtitle="Where every order stands, and what needs you." />
      <div className="mx-auto max-w-[1400px] space-y-6 px-4 pb-10 sm:px-6">
        {/* The status register: each figure opens the matching orders. */}
        <nav
          aria-label="Orders by status"
          className="grid gap-x-4 gap-y-3 lg:grid-cols-[2fr_1fr_4fr]"
        >
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="min-w-0">
              <h2 className="caption mb-1.5">{g.label}</h2>
              <div
                className={`grid ${g.cols} gap-px overflow-hidden rounded-md border bg-[var(--rule)]`}
              >
                {g.rows.map((r) => (
                  <Link
                    key={r.status}
                    to={`/orders?status=${r.status}`}
                    className="min-w-0 bg-card px-4 py-3 hover:bg-muted"
                  >
                    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full"
                        style={{ background: STATUS_COLOR[r.status as keyof typeof STATUS_COLOR] }}
                      />
                      {r.label}
                    </span>
                    <span className="mt-0.5 flex items-baseline gap-2">
                      <span className="font-semibold text-xl tabular">{r.n}</span>
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
        </nav>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            {decisions.length ? (
              <Section
                title={
                  <span className="flex items-center gap-2">
                    Needs a decision
                    {decisions.length ? (
                      <span className="rounded-sm bg-wait/15 px-1.5 py-px font-medium text-[11px] text-wait tabular">
                        {decisions.length + moreDecisions}
                      </span>
                    ) : null}
                  </span>
                }
                actions={
                  decisions.length ? (
                    <Link to="/approvals" className="text-link text-xs hover:underline">
                      Open the queue
                    </Link>
                  ) : null
                }
                flush
              >
                {decisions.length ? (
                  <ul className="divide-y">
                    {decisions.map((d) => (
                      <li key={d.id}>
                        <Link
                          to={`/orders/${d.orderId}`}
                          className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <span className="font-medium">
                                {d.orderTitle ||
                                  (d.orderModel
                                    ? ORDER_MODEL_LABELS[d.orderModel as OrderModel]
                                    : '')}
                              </span>
                              <span className="font-mono font-normal text-muted-foreground text-xs">
                                {orderRef(d.orderId)}
                              </span>
                              <span className="text-muted-foreground text-sm">
                                {d.customerName ?? d.customerId}
                              </span>
                            </div>
                            <DecisionContext ctx={d.ctx} className="mt-1" />
                            <p className="mt-1 text-muted-foreground text-xs">
                              For {humanize(d.assignee) || 'anyone'} · requested{' '}
                              <Ago ms={d.requestedAt} />
                            </p>
                          </div>
                          <span className="font-semibold tabular">
                            {money(d.amount, d.currency ?? undefined)}
                          </span>
                          <ChevronRight
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </Link>
                      </li>
                    ))}
                    {moreDecisions ? (
                      <li className="px-4 py-2.5 text-sm">
                        <Link to="/approvals" className="text-link hover:underline">
                          {moreDecisions} more in the queue
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </Section>
            ) : (
              <p className="flex items-center gap-2 rounded-md border bg-card px-4 py-2.5 text-muted-foreground text-sm">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-idle" />
                Nothing is waiting on a person.
                <Link
                  to="/approvals?status=all"
                  className="ml-auto text-link text-xs hover:underline"
                >
                  Past approvals
                </Link>
              </p>
            )}

            <Section
              title="Recently updated"
              actions={
                <Link to="/orders" className="text-link text-xs hover:underline">
                  All orders
                </Link>
              }
              flush
            >
              {recent.length ? (
                <ul className="divide-y">
                  {recent.map((o) => (
                    <li key={o.id}>
                      <Link
                        to={`/orders/${o.id}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]"
                      >
                        <span className="order-3 col-span-2 sm:order-none sm:col-span-1">
                          <StatusBadge status={orderStatus(o.status, o.id, declined)} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-sm">
                            {o.title || ORDER_MODEL_LABELS[o.model as OrderModel]}{' '}
                            <span className="font-mono font-normal text-muted-foreground text-xs">
                              {orderRef(o.id)}
                            </span>
                          </span>
                          <span className="block truncate text-muted-foreground text-xs">
                            {(o.customerId && names[o.customerId]) || o.customerId || 'No customer'}{' '}
                            · {ORDER_MODEL_LABELS[o.model as OrderModel]}
                            {o.waitingOn ? (
                              <>
                                {' · '}
                                <WaitingAt
                                  prefix
                                  at={o.waitingAt}
                                  since={o.waitingSince}
                                  on={o.waitingOn}
                                />
                              </>
                            ) : null}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="block text-sm tabular">
                            {money(o.total, o.currency)}
                          </span>
                          <span className="block text-muted-foreground text-xs">
                            <Ago ms={o.updatedAt} />
                          </span>
                        </span>
                      </Link>
                    </li>
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

          <aside className="min-w-0 space-y-6">
            <Section title="Waiting on" flush>
              {lanes.length ? (
                <ul className="divide-y text-sm">
                  {lanes.map(([what, n]) => (
                    <li key={what} className="flex items-center gap-3 px-4 py-2">
                      <span className="min-w-0 flex-1 truncate" title={what}>
                        {what}
                      </span>
                      <span className="font-medium tabular">{n}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No order is paused.</Empty>
              )}
            </Section>

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
                </div>
              </details>
            ) : null}
          </aside>
        </div>

        <Performance p={perf} />
      </div>
    </>
  );
}
