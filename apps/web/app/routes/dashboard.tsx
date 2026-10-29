import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  SCENARIOS,
  toBase,
} from '@orderloop/core';
import { Badge } from '@orderloop/ui/badge';
import { Button } from '@orderloop/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@orderloop/ui/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import { ArrowRight, ChevronRight, Inbox, Play, ReceiptText } from 'lucide-react';
import { useEffect, useId } from 'react';
import { Link, useLoaderData, useRevalidator } from 'react-router';
import { Ago } from '~/components/ago';
import { DecisionDeadline } from '~/components/decision';
import { Empty, PageHeader, Section } from '~/components/page';
import { StatusDot } from '~/components/status';
import { rowContext } from '~/lib/approvals';
import { useStartOrder } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded, flowSteps } from '~/lib/flows.server';
import {
  assigneeLabel,
  clip,
  duration,
  liveStatus,
  money,
  orderRef,
  orderStatus,
  STATUS_COLOR,
  statusLabel,
} from '~/lib/format';
import { customerNames, declinedOrderIds, demoAvailable, overview } from '~/lib/orders.server';
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
    // An open order with no run reads "recorded", never waiting (`liveStatus`).
    recent: o.recent.map((r) => ({ ...r, status: liveStatus(r) })),
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
  // A demo scenario starts through the assistant and opens its order.
  const scenario = useStartOrder();
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
  const completed = day('completed');
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
      {/* A column of cards. On a phone the two grids below dissolve into it (`contents`), so the
          decision can come first, above the figures, while the first screen still has room. */}
      <div className="mx-auto flex max-w-page flex-col gap-4 px-4 pb-10 sm:px-6 lg:gap-6">
        {/* Open work now, then the last day's endings: each figure opens the matching orders. */}
        <nav aria-label="Orders by status" className="grid gap-4 lg:grid-cols-[2fr_5fr]">
          <section aria-label="Open now" className="grid grid-cols-2 gap-4">
            {now.map((f) => (
              <FigureCard key={f.status} f={f} />
            ))}
          </section>
          <Card size="sm" className="min-w-0 gap-2">
            <CardHeader>
              <CardDescription>
                <h2>Ended in the last 24 hours</h2>
              </CardDescription>
              {completed?.n ? (
                <CardAction>
                  <Badge variant="secondary" className="tabular">
                    {money(completed.total ?? 0, BASE_CURRENCY)} completed
                  </Badge>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent className="px-2 max-md:overflow-x-auto">
              <ul className="grid grid-cols-5 gap-1 max-md:flex">
                {lastDay.map((f) => (
                  <li key={f.status} className="min-w-0 max-md:shrink-0">
                    <Ending f={f} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </nav>

        {/* Phones read decisions (moved above the figures), then where orders wait, then what
            ended badly, then recent orders; wide screens put what ended badly in the rail. */}
        <div className="grid gap-4 max-md:contents lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
          <div className="min-w-0 max-md:contents md:space-y-6 lg:col-start-1">
            {decisions.length ? (
              <Section
                className="max-md:-order-1"
                title={
                  <span className="flex items-center gap-2">
                    Needs a decision
                    <Badge className="border-transparent bg-wait/15 text-wait tabular">
                      {decisions.length + moreDecisions}
                    </Badge>
                  </span>
                }
                description="Each of these orders is paused until someone decides."
                actions={
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/approvals">Open the queue</Link>
                  </Button>
                }
              >
                <ul className="flex flex-col gap-2">
                  {decisions.map((d) => (
                    <DecisionItem key={d.id} d={d} />
                  ))}
                </ul>
                {moreDecisions ? (
                  <Link
                    to="/approvals"
                    className="mt-3 inline-block text-link text-sm hover:underline"
                  >
                    {moreDecisions} more in the queue
                  </Link>
                ) : null}
              </Section>
            ) : (
              <Card size="sm" className="max-md:-order-1">
                <CardContent>
                  <Item size="sm" className="p-0">
                    <ItemMedia variant="icon" className="size-8 rounded-full bg-muted">
                      <Inbox className="text-muted-foreground" aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>No decisions waiting</ItemTitle>
                      <ItemDescription>Approvals that need you appear here.</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to="/approvals?status=all">Past approvals</Link>
                      </Button>
                    </ItemActions>
                  </Item>
                </CardContent>
              </Card>
            )}

            <WaitingTrails trails={trails} moving={moving} />
          </div>

          <aside
            aria-label="Ended badly"
            className="min-w-0 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:space-y-6"
          >
            <EndedBadly steps={stopped} />

            {canOperate && demo ? (
              <Card size="sm" className="gap-0 py-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-(--card-spacing) py-3">
                    <span className="section-title">Demo scenarios</span>
                    <ChevronRight
                      className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="flex flex-col gap-1 border-t p-2">
                    {SCENARIOS.map((s) => (
                      <Item
                        key={s.id}
                        asChild
                        size="xs"
                        className="group/s text-left hover:bg-muted"
                      >
                        <button
                          type="button"
                          disabled={!!scenario.busy}
                          className="disabled:opacity-60"
                          onClick={() =>
                            void scenario.start(s.id, 'start_scenario', { scenarioId: s.id })
                          }
                        >
                          <ItemMedia variant="icon">
                            <Play className="text-muted-foreground" aria-hidden="true" />
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle>{s.label}</ItemTitle>
                            <ItemDescription className="text-xs leading-snug">
                              {s.blurb}
                            </ItemDescription>
                          </ItemContent>
                          <ArrowRight
                            className="size-3.5 opacity-0 transition group-hover/s:opacity-60"
                            aria-hidden="true"
                          />
                        </button>
                      </Item>
                    ))}
                    {scenario.error ? (
                      <p className="px-3 pt-1 text-bad text-xs" role="alert">
                        {scenario.error.message}
                      </p>
                    ) : null}
                    <Link
                      to="/orders/scenarios"
                      className="block px-3 pt-1.5 pb-1 text-link text-sm hover:underline"
                    >
                      See what each one fails on, or edit one first
                    </Link>
                  </div>
                </details>
              </Card>
            ) : null}
          </aside>

          <div className="min-w-0 lg:col-start-1">
            <Section
              title="Recently updated"
              description="The orders that changed last, and where each one is."
              actions={
                <Button variant="outline" size="sm" asChild>
                  <Link to="/orders?sort=updated">All orders</Link>
                </Button>
              }
            >
              {recent.length ? (
                <ul className="-mx-2 flex flex-col gap-1">
                  {recent.map((o) => (
                    <RecentItem
                      key={o.id}
                      o={o}
                      customer={(o.customerId && names[o.customerId]) || o.customerId}
                      status={orderStatus(o.status, o.id, declined)}
                    />
                  ))}
                </ul>
              ) : (
                <Empty
                  icon={<ReceiptText aria-hidden="true" />}
                  title="No orders yet"
                  action={
                    <Button size="sm" asChild>
                      <Link to="/orders/new">Start an order</Link>
                    </Button>
                  }
                >
                  Orders from the API, your storefronts, email and this console appear here as they
                  change.
                </Empty>
              )}
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

/** A figure's colour when it should carry one: a bad ending with orders in it. */
const badFigure = (f: Figure) => f.n > 0 && (f.status === 'failed' || f.status === 'rolled_back');

/** The label of a figure: its status dot and words. */
function FigureLabel({ f }: { f: Figure }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs">
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full"
        style={{ background: STATUS_COLOR[f.status as keyof typeof STATUS_COLOR] }}
      />
      {f.label}
    </span>
  );
}

const figureName = (f: Figure) =>
  `${f.label}: ${f.n} ${f.n === 1 ? 'order' : 'orders'}${f.note ? `, ${f.note}` : ''}`;

/**
 * Open work, as a card of its own (the preview cards' balance tiles): set large, since it is what
 * can still be acted on. The whole card opens those orders.
 */
function FigureCard({ f }: { f: Figure }) {
  return (
    <Card size="sm" className="relative gap-1 transition-colors hover:bg-muted/40">
      <CardContent className="flex flex-1 flex-col justify-between gap-1">
        <CardDescription>
          <Link
            to={f.to}
            aria-label={figureName(f)}
            className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
          >
            <FigureLabel f={f} />
          </Link>
        </CardDescription>
        <CardTitle className="font-semibold text-2xl tabular max-md:text-xl">{f.n}</CardTitle>
      </CardContent>
    </Card>
  );
}

/**
 * One ending in the last day's card. A bad ending with any orders takes its status colour, so a
 * failure isn't drawn like a completion. On a phone the row scrolls sideways when it doesn't fit,
 * so it doesn't push the decision queue off the first screen.
 */
function Ending({ f }: { f: Figure }) {
  const bad = badFigure(f);
  return (
    <Link
      to={f.to}
      aria-label={figureName(f)}
      className="block min-w-0 rounded-xl px-3 py-2 hover:bg-muted max-md:flex max-md:min-h-11 max-md:items-center max-md:gap-2 max-md:py-1"
    >
      <FigureLabel f={f} />
      <span
        className={cn(
          'mt-0.5 block font-medium text-lg tabular max-md:mt-0 max-md:text-base',
          bad && 'font-semibold',
        )}
        style={bad ? { color: STATUS_COLOR[f.status as keyof typeof STATUS_COLOR] } : undefined}
      >
        {f.n}
      </span>
    </Link>
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
 * One approval waiting on a person, read as the inbox reads it: the order, then its deadline and
 * reason on one line. The item opens the order, where the figures are. When decisions close it says
 * so in place, in ink: amber is for overdue ages.
 */
function DecisionItem({ d }: { d: Data['decisions'][number] }) {
  const detailId = useId();
  const deadline = d.ctx.deadline;
  const name =
    d.orderTitle || (d.orderModel ? ORDER_MODEL_LABELS[d.orderModel as OrderModel] : 'Order');
  return (
    <Item asChild variant="muted" size="sm" className="relative items-start hover:bg-muted">
      <li>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full flex-wrap gap-x-2 gap-y-0">
            <Link
              to={`/orders/${d.orderId}`}
              aria-describedby={detailId}
              className="after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
            >
              {name}{' '}
              <span className="font-mono font-normal text-muted-foreground text-xs">
                {orderRef(d.orderId)}
              </span>
            </Link>
            <span className="font-normal text-muted-foreground">
              {d.customerName ?? d.customerId}
            </span>
          </ItemTitle>
          <div id={detailId} className="flex flex-col gap-1">
            {deadline !== undefined || d.ctx.reason ? (
              <p className="flex min-w-0 items-baseline gap-x-2 text-sm">
                {deadline !== undefined ? (
                  <DecisionDeadline
                    deadline={deadline}
                    onTimeout={d.ctx.onTimeout}
                    className="shrink-0"
                  />
                ) : null}
                {d.ctx.reason ? (
                  <span className="min-w-0 truncate font-medium" title={d.ctx.reason}>
                    {d.ctx.reason}
                  </span>
                ) : null}
              </p>
            ) : null}
            {d.noRun ? (
              <ItemDescription>
                No live run for this order, so it can’t be decided here.
              </ItemDescription>
            ) : null}
            <ItemDescription className="text-xs">
              {d.ctx.step ? `${d.ctx.step} · assigned to` : 'Assigned to'}{' '}
              {assigneeLabel(d.assignee) || 'any approver'} · requested <Ago ms={d.requestedAt} />
            </ItemDescription>
          </div>
        </ItemContent>
        <ItemActions className="self-start font-semibold text-sm">
          <Amount amount={d.amount} currency={d.currency} fxRate={d.fxRate} />
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </ItemActions>
      </li>
    </Item>
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
          // `useNow` reads the render's clock, so server and browser can differ by a second.
          <span className="text-muted-foreground" suppressHydrationWarning>
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
        {o.reason ? (
          <span className="text-muted-foreground" title={clip(o.reason, 500)}>
            : {clip(o.reason)}
          </span>
        ) : null}
      </>
    );
  return <>{statusLabel(status)}</>;
}

/**
 * One recently updated order, led by where it is (its step, or where it ended) rather than a
 * badge: the loop, not just a status. The dot carries the status colour; the words carry the rest.
 */
function RecentItem({
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
    <Item asChild size="xs" className="relative items-start px-2 hover:bg-muted/60">
      <li>
        <ItemMedia className="mt-1.5 self-start">
          <StatusDot status={status} />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <Link
              to={`/orders/${o.id}`}
              aria-describedby={detailId}
              className="truncate after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
            >
              {name}{' '}
              <span className="font-mono font-normal text-muted-foreground text-xs">
                {orderRef(o.id)}
              </span>
            </Link>
          </ItemTitle>
          <span id={detailId} className="block">
            <span className={cn('block truncate text-ui', tone)}>
              <Position o={o} status={status} />
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {customer || (o.contactEmail ? `Guest · ${o.contactEmail}` : 'No customer')}
              {o.title || o.externalId ? ` · ${model}` : ''}
            </span>
          </span>
        </ItemContent>
        <ItemActions className="flex-col items-end gap-0 self-start text-sm">
          <Amount amount={o.total} currency={o.currency} fxRate={o.fxRate} />
          <span className="text-muted-foreground text-xs">
            <Ago ms={o.updatedAt} />
          </span>
        </ItemActions>
      </li>
    </Item>
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
      description="Each flow's waiting steps, in the order the flow runs them."
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to="/orders?status=waiting&sort=waiting">See all</Link>
        </Button>
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
                      <Item
                        asChild
                        variant="muted"
                        size="xs"
                        className="w-auto min-w-0 max-w-[16rem] flex-col items-start gap-0 hover:bg-muted"
                      >
                        <Link
                          to={`/orders?flow=${encodeURIComponent(t.flowId)}&step=${encodeURIComponent(s.step)}&status=waiting&sort=waiting`}
                        >
                          <span className="flex max-w-full items-baseline gap-2">
                            <span className="font-semibold text-lg tabular">{s.n}</span>
                            <span className="truncate text-sm">{s.step}</span>
                          </span>
                          <span
                            className="block max-w-full truncate text-muted-foreground text-xs"
                            suppressHydrationWarning
                          >
                            {s.overdue ? (
                              <span className="font-medium text-wait">{s.overdue} overdue</span>
                            ) : null}
                            {s.overdue && (age !== null || s.on) ? ' · ' : null}
                            {age !== null ? `oldest ${duration(age)}` : null}
                            {age !== null && s.on ? ' · ' : null}
                            {s.on ? `on ${s.on}` : null}
                          </span>
                        </Link>
                      </Item>
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
      description="Failed or rolled back, by the step they stopped at."
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to="/orders?attention=1&within=7d&sort=updated">See all</Link>
        </Button>
      }
    >
      {steps.length ? (
        <>
          <ul className="-mx-2 flex flex-col gap-1" aria-label={`${total} failed or rolled back`}>
            {steps.slice(0, 8).map((s) => (
              <Item
                asChild
                size="xs"
                key={`${s.flowId}-${s.step}`}
                className="relative px-2 hover:bg-muted/60"
              >
                <li>
                  <ItemContent className="min-w-0 gap-0">
                    <ItemTitle className="w-full">
                      <Link
                        to={`/orders?flow=${encodeURIComponent(s.flowId)}&step=${encodeURIComponent(s.step)}&attention=1&within=7d&sort=updated`}
                        className="min-w-0 truncate after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                      >
                        {s.step}
                        <span className="font-normal text-muted-foreground"> · {s.name}</span>
                      </Link>
                    </ItemTitle>
                    {s.reason ? (
                      <ItemDescription className="line-clamp-1 text-xs" title={clip(s.reason, 500)}>
                        {clip(s.reason)}
                      </ItemDescription>
                    ) : null}
                    <ItemDescription className="text-xs">
                      {s.rolledBack ? (
                        <span className="text-undo">{s.rolledBack} rolled back · </span>
                      ) : null}
                      latest <Ago ms={s.latest} />
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="self-start text-muted-foreground text-xs tabular">
                    <span>
                      <span className="font-semibold text-bad text-sm">{s.n}</span>{' '}
                      {s.n === 1 ? 'order' : 'orders'}
                    </span>
                  </ItemActions>
                </li>
              </Item>
            ))}
          </ul>
          {steps.length > 8 ? (
            <Link
              to="/orders?attention=1&within=7d&sort=updated"
              className="mt-3 inline-block text-link text-xs hover:underline"
            >
              {steps.length - 8} more steps
            </Link>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing failed or rolled back this week.</p>
      )}
    </Section>
  );
}
