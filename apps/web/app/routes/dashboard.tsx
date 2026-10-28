import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  toBase,
} from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
import { ArrowRight, ChevronRight, Play } from 'lucide-react';
import { useEffect, useId } from 'react';
import { Form, Link, useLoaderData, useNavigation, useRevalidator } from 'react-router';
import { Ago } from '~/components/ago';
import { DecisionContext, lockAt } from '~/components/decision';
import { Empty, PageHeader, Section } from '~/components/page';
import { StatusDot } from '~/components/status';
import { rowContext } from '~/lib/approvals';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded, flowSteps } from '~/lib/flows.server';
import {
  duration,
  humanize,
  money,
  orderRef,
  orderStatus,
  STATUS_COLOR,
  statusLabel,
} from '~/lib/format';
import { customerNames, declinedOrderIds, demoAvailable, overview } from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import { startScenario } from '~/lib/scenarios.server';
import { useDateTime } from '~/lib/use-date-time';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import { type StoppedStep, stoppedSteps, type WaitTrail, waitTrails } from '~/lib/where';
import type { Route } from './+types/dashboard';

export const meta = () => [{ title: 'Overview · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  // Signed in first (the shell shares this lookup), so a signed-out visitor costs no reads and
  // gets the redirect, not an error from one of them.
  await requireUser(request);
  const [, o, steps, demo] = await Promise.all([
    ensureSeeded(),
    overview(),
    flowSteps(),
    demoAvailable(),
  ]);
  const top = o.approvals;
  const [names, declinedSet, states] = await Promise.all([
    customerNames(o.recent.map((r) => r.customerId)),
    declinedOrderIds(o.recent.map((r) => r.id)),
    Promise.all(
      // null: the order has no live run. undefined: the read failed, which says nothing.
      top.map((a) =>
        engine()
          .snapshot(a.orderId)
          .catch(() => undefined),
      ),
    ),
  ]);
  const decisions = top.map(({ startedBy: _, total: __, ...a }, i) => ({
    ...a,
    ctx: rowContext(states[i] as OrderState | null | undefined, a),
    noRun: states[i] === null,
  }));
  return {
    open: o.open,
    ended24h: o.ended24h,
    declined24h: o.declined24h,
    recent: o.recent,
    names,
    declined: [...declinedSet],
    demo,
    decisions,
    moreDecisions: Math.max(0, o.pendingApprovals - top.length),
    trails: waitTrails(o.waitsByFlow, steps),
    stopped: stoppedSteps(o.stoppedWeek, steps),
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

/** A figure in the status strip: what it counts, how many, and the orders it opens. */
type Figure = { label: string; n: number; status: string; to: string; note?: string };

export default function Dashboard() {
  const {
    open: openRows,
    ended24h,
    declined24h,
    recent,
    names,
    declined,
    decisions,
    moreDecisions,
    trails,
    stopped,
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
  const open = (s: string[]) =>
    openRows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  const day = (s: string) => ended24h.find((r) => r.status === s);
  const moving = open(['queued', 'running']);
  // Open work as it is now; endings over the last day. All-time totals are on Performance.
  const now: Figure[] = [
    { label: 'In flight', n: moving, status: 'running', to: '/orders?status=running' },
    {
      label: 'Waiting',
      n: open(['waiting']),
      status: 'waiting',
      to: '/orders?status=waiting&sort=waiting',
    },
  ];
  const since = (status: string) => `/orders?status=${status}&within=24h&sort=updated`;
  const lastDay: Figure[] = [
    {
      label: 'Completed',
      n: day('completed')?.n ?? 0,
      status: 'completed',
      to: since('completed'),
      note: day('completed')?.n ? money(day('completed')?.total ?? 0, BASE_CURRENCY) : undefined,
    },
    { label: 'Failed', n: day('failed')?.n ?? 0, status: 'failed', to: since('failed') },
    {
      label: 'Rolled back',
      n: day('rolled_back')?.n ?? 0,
      status: 'rolled_back',
      to: since('rolled_back'),
    },
    // Older policy declines were stored as cancelled; count them where they belong.
    {
      label: 'Declined',
      n: (day('declined')?.n ?? 0) + declined24h,
      status: 'declined',
      to: since('declined'),
    },
    {
      label: 'Cancelled',
      n: (day('cancelled')?.n ?? 0) - declined24h,
      status: 'cancelled',
      to: since('cancelled'),
    },
  ];
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            What needs you, and where your orders are.{' '}
            <span className="whitespace-nowrap" suppressHydrationWarning>
              {refreshing === 'loading' ? 'Updating…' : `Updated ${formatTime(at)}`}
            </span>
          </>
        }
      />
      <div className="mx-auto max-w-page space-y-6 px-4 pb-10 sm:px-6">
        {/* Open work now, then the last day's endings: each figure opens the matching orders. */}
        <nav aria-label="Orders by status" className="grid gap-x-4 gap-y-3 lg:grid-cols-[2fr_5fr]">
          <Strip title="Open now" figures={now} cols="grid-cols-2" lead />
          <Strip
            title="Ended in the last 24 hours"
            figures={lastDay}
            cols="grid-cols-2 sm:grid-cols-5"
          />
        </nav>

        {/* Phones read decisions, then where orders wait, then what ended badly, then recent
            orders; wide screens put what ended badly in the rail beside the rest. */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div className="min-w-0 space-y-6 lg:col-start-1">
            {decisions.length ? (
              <Section
                title={
                  <span className="flex items-center gap-2">
                    Needs a decision
                    <span className="rounded-full bg-wait/15 px-2 py-px font-medium text-2xs text-wait tabular">
                      {decisions.length + moreDecisions}
                    </span>
                  </span>
                }
                actions={
                  <Link to="/approvals" className="hit-area text-link text-xs hover:underline">
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
              <p className="flex items-center gap-2 card px-5 py-3 text-sm">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" />
                <span>
                  <span className="font-medium">No decisions waiting.</span>{' '}
                  <span className="text-muted-foreground">
                    Approvals that need you appear here.
                  </span>
                </span>
                <Link
                  to="/approvals?status=all"
                  className="hit-area ml-auto shrink-0 text-link text-xs hover:underline"
                >
                  Past approvals
                </Link>
              </p>
            )}

            <WaitingTrails trails={trails} moving={moving} />
          </div>

          <aside
            aria-label="Ended badly"
            className="min-w-0 space-y-6 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          >
            <EndedBadly steps={stopped} />

            {canOperate && demo ? (
              <details className="group card overflow-hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3">
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
                        className="group/s flex w-full items-start gap-3 rounded-2xl px-3 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
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
                    className="block px-3 pt-1.5 pb-1 text-link text-sm hover:underline"
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
                <Link
                  to="/orders?sort=updated"
                  className="hit-area text-link text-xs hover:underline"
                >
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
      </div>
    </>
  );
}

/**
 * A group of figures in the status strip. `lead` is open work, set larger: it is what can still be
 * acted on. A bad ending with any orders takes its status colour, so a failure isn't drawn like a
 * completion.
 */
function Strip({
  title,
  figures,
  cols,
  lead,
}: {
  title: string;
  figures: Figure[];
  cols: string;
  lead?: boolean;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="caption mb-1.5">{title}</h2>
      <div className={`card grid ${cols} gap-1 p-1.5`}>
        {figures.map((f) => {
          const bad = f.n > 0 && (f.status === 'failed' || f.status === 'rolled_back');
          return (
            <Link
              key={f.status}
              to={f.to}
              aria-label={`${f.label}: ${f.n} ${f.n === 1 ? 'order' : 'orders'}${f.note ? `, ${f.note}` : ''}`}
              className="min-w-0 rounded-3xl px-4 py-2.5 hover:bg-muted"
            >
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full"
                  style={{ background: STATUS_COLOR[f.status as keyof typeof STATUS_COLOR] }}
                />
                {f.label}
              </span>
              <span className="mt-0.5 flex items-baseline gap-2">
                <span
                  className={cn(
                    'tabular',
                    lead ? 'font-semibold text-2xl' : 'font-medium text-lg',
                    bad && 'font-semibold',
                  )}
                  style={
                    bad ? { color: STATUS_COLOR[f.status as keyof typeof STATUS_COLOR] } : undefined
                  }
                >
                  {f.n}
                </span>
                {f.note ? (
                  <span className="truncate text-muted-foreground text-xs tabular">{f.note}</span>
                ) : null}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
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
          {d.noRun ? (
            <p className="mt-1 text-muted-foreground text-sm">
              No live run for this order, so it can’t be decided here.
            </p>
          ) : null}
          <p className="mt-1 text-muted-foreground text-xs">
            {d.ctx.step ? `${d.ctx.step} · assigned to` : 'Assigned to'}{' '}
            {humanize(d.assignee) || 'any approver'} · requested <Ago ms={d.requestedAt} />
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

/** Where an order is, in words: the step it waits at and for how long, or where and why it ended. */
function Position({ o, status }: { o: Data['recent'][number]; status: string }) {
  const now = useNow(30_000);
  if (status === 'waiting' && (o.waitingAt || o.waitingOn))
    return (
      <>
        Waiting at {o.waitingAt ?? o.waitingOn}
        {o.waitingSince ? (
          <span className="text-muted-foreground">
            {' '}
            · {duration(Math.max(0, now - o.waitingSince))}
          </span>
        ) : null}
      </>
    );
  if (o.stoppedAt || o.reason)
    return (
      <>
        {statusLabel(status)}
        {o.stoppedAt ? ` at ${o.stoppedAt}` : ''}
        {o.reason ? <span className="text-muted-foreground">: {o.reason}</span> : null}
      </>
    );
  return <>{statusLabel(status)}</>;
}

/**
 * One recently updated order, led by where it is (its step, or where it ended) rather than a
 * badge: the loop, not just a status. The dot carries the status colour; the words carry the rest.
 */
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
  const model = ORDER_MODEL_LABELS[o.model as OrderModel];
  const name = o.title || o.externalId || model;
  const tone =
    status === 'failed' ? 'text-bad' : status === 'rolled_back' ? 'text-undo' : 'text-foreground';
  return (
    <li className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-5 py-2.5 hover:bg-muted/40">
      <StatusDot status={status} className="mt-1.5" />
      <span className="min-w-0">
        <Link
          to={`/orders/${o.id}`}
          aria-describedby={detailId}
          className="block truncate font-medium text-sm after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
        >
          {name}{' '}
          <span className="font-mono font-normal text-muted-foreground text-xs">
            {orderRef(o.id)}
          </span>
        </Link>
        <span id={detailId} className="block">
          <span className={cn('block truncate text-ui', tone)}>
            <Position o={o} status={status} />
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {customer || (o.contactEmail ? `Guest · ${o.contactEmail}` : 'No customer')}
            {o.title || o.externalId ? ` · ${model}` : ''}
          </span>
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
 * Where open orders are waiting, along each flow: its waiting steps in the order the flow runs
 * them, each with how many wait there, how many are overdue, the oldest wait and what it waits on.
 * Only the overdue count takes the wait colour: a long wait that is still within its step's
 * deadline is on time. Each step opens those orders, longest-waiting first.
 */
function WaitingTrails({ trails, moving }: { trails: WaitTrail[]; moving: number }) {
  const now = useNow(30_000);
  return (
    <Section
      title="Where orders are waiting"
      actions={
        <Link
          to="/orders?status=waiting&sort=waiting"
          className="hit-area text-link text-xs hover:underline"
        >
          See all
        </Link>
      }
    >
      {trails.length ? (
        <ul className="space-y-4">
          {trails.map((t) => (
            <li key={t.flowId}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <Link
                  to={`/orders?flow=${encodeURIComponent(t.flowId)}&status=waiting&sort=waiting`}
                  className="truncate font-medium text-sm hover:underline"
                >
                  {t.name}
                </Link>
                <span className="shrink-0 text-muted-foreground text-xs tabular">
                  {t.open} waiting
                </span>
              </div>
              <ol
                className="flex flex-wrap items-stretch gap-y-2"
                aria-label={`${t.name}: steps with orders waiting, in flow order`}
              >
                {t.steps.map((s, i) => {
                  const age = s.oldest === null ? null : Math.max(0, now - s.oldest);
                  return (
                    <li key={s.step} className="flex items-stretch">
                      {i > 0 ? (
                        <span
                          aria-hidden="true"
                          className="mx-1 w-3 self-center border-t border-dashed sm:w-5"
                        />
                      ) : null}
                      <Link
                        to={`/orders?flow=${encodeURIComponent(t.flowId)}&step=${encodeURIComponent(s.step)}&status=waiting&sort=waiting`}
                        className="tile block min-w-0 max-w-[16rem] px-3.5 py-2 hover:bg-muted"
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="font-semibold text-lg tabular">{s.n}</span>
                          <span className="truncate text-sm">{s.step}</span>
                        </span>
                        <span className="block truncate text-muted-foreground text-xs">
                          {s.overdue ? (
                            <span className="font-medium text-wait">{s.overdue} overdue</span>
                          ) : null}
                          {s.overdue && (age !== null || s.on) ? ' · ' : null}
                          {age !== null ? `oldest ${duration(age)}` : null}
                          {age !== null && s.on ? ' · ' : null}
                          {s.on ? `on ${s.on}` : null}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No order is waiting at a step.</p>
      )}
      {moving ? (
        <p className="mt-4 text-muted-foreground text-xs">
          {moving} more {moving === 1 ? 'order is' : 'orders are'} moving between steps on their
          own.
        </p>
      ) : null}
    </Section>
  );
}

/**
 * What failed or rolled back this week, grouped by the step it stopped at, the step with the most
 * first, with the latest reason: a step failing repeatedly is a flow to fix, not orders to chase.
 */
function EndedBadly({ steps }: { steps: StoppedStep[] }) {
  const total = steps.reduce((a, s) => a + s.n, 0);
  return (
    <Section
      title="Ended badly this week"
      actions={
        <Link
          to="/orders?attention=1&within=7d&sort=updated"
          className="hit-area text-link text-xs hover:underline"
        >
          See all
        </Link>
      }
      flush
    >
      {steps.length ? (
        <>
          <ul className="divide-y" aria-label={`${total} failed or rolled back`}>
            {steps.slice(0, 8).map((s) => (
              <li key={`${s.flowId}-${s.step}`} className="relative px-5 py-2.5 hover:bg-muted/40">
                <div className="flex items-baseline gap-3">
                  <Link
                    to={`/orders?flow=${encodeURIComponent(s.flowId)}&step=${encodeURIComponent(s.step)}&attention=1&within=7d&sort=updated`}
                    className="min-w-0 flex-1 truncate text-sm after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                  >
                    <span className="font-medium">{s.step}</span>
                    <span className="text-muted-foreground"> · {s.name}</span>
                  </Link>
                  <span className="shrink-0 text-muted-foreground text-xs tabular">
                    <span className="font-semibold text-bad text-sm">{s.n}</span>{' '}
                    {s.n === 1 ? 'order' : 'orders'}
                  </span>
                </div>
                {s.reason ? (
                  <p className="truncate text-muted-foreground text-xs" title={s.reason}>
                    {s.reason}
                  </p>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  {s.rolledBack ? (
                    <span className="text-undo">{s.rolledBack} rolled back · </span>
                  ) : null}
                  latest <Ago ms={s.latest} />
                </p>
              </li>
            ))}
          </ul>
          {steps.length > 8 ? (
            <Link
              to="/orders?attention=1&within=7d&sort=updated"
              className="hit-area block border-t px-5 py-2.5 text-link text-xs hover:underline"
            >
              {steps.length - 8} more steps
            </Link>
          ) : null}
        </>
      ) : (
        <p className="px-5 pb-4 text-muted-foreground text-sm">
          Nothing failed or rolled back this week.
        </p>
      )}
    </Section>
  );
}
