/**
 * The live order page. The loader renders a snapshot; in the browser, `useAgent` connects to the
 * order's OrderAgent (proxied by workers/app.ts) and every state change it broadcasts re-renders
 * the graph, waits and timeline. Actions are agent RPC calls over the same socket. Questions about
 * the order go to the assistant panel, which this page tells which order it is on.
 */

import {
  FULFILLMENT_METHOD_LABELS,
  mergeTimeline,
  ORDER_CHANNEL_LABELS,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  OWN_ORDER_REFUSAL,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Card, CardContent } from '@orderloop/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@orderloop/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import { Table, TableBody, TableFoot, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { useAgent } from 'agents/react';
import {
  ChevronRight,
  CircleSlash,
  Ellipsis,
  ExternalLink,
  FileText,
  Mail,
  MessageSquareText,
  MousePointerClick,
  RotateCcw,
  Undo2,
  Workflow,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  data,
  Link,
  type ShouldRevalidateFunctionArgs,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { Ago } from '~/components/ago';
import { DecisionContext, DecisionControls, sendDecision } from '~/components/decision';
import { FlowCanvas } from '~/components/flow-canvas';
import { Inspector } from '~/components/inspector';
import { Empty, Section } from '~/components/page';
import { ShareButton } from '~/components/share-button';
import { StatusBadge, StatusDot } from '~/components/status';
import { approvalContext } from '~/lib/approvals';
import { useAssistant, usePageContext } from '~/lib/assistant';
import { actor, requireUser } from '~/lib/auth.server';
import { useMedia, WIDE } from '~/lib/device';
import { engine } from '~/lib/env.server';
import { eventAction, eventWaiting } from '~/lib/events';
import {
  assigneeLabel,
  clip,
  duration,
  humanize,
  money,
  offset,
  orderRef,
  plainLog,
  plural,
  readableReason,
  statusColor,
} from '~/lib/format';
import { customerNames, orderRecords, recordedOrder } from '~/lib/orders.server';
import { useArrivals } from '~/lib/use-arrivals';
import { useDateTime } from '~/lib/use-date-time';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/order';

export const meta = ({ loaderData: d, params }: Route.MetaArgs) => {
  const o = d?.snapshot?.order ?? d?.recorded?.order;
  return [
    {
      title: `${o?.title || (o ? ORDER_MODEL_LABELS[o.model as OrderModel] : 'Order')} ${orderRef(params.orderId)} · OrderLoop`,
    },
  ];
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const me = await requireUser(request);
  // The live state and the D1 records are independent: read them together.
  const [snapshot, records] = await Promise.all([
    engine().snapshot(params.orderId),
    orderRecords(params.orderId),
  ]);
  // No run in the engine (a generated order, say): what D1 recorded, read-only.
  const recorded = snapshot ? null : await recordedOrder(params.orderId);
  if (!snapshot && !recorded) throw data('Order not found', { status: 404 });
  const customerId = snapshot ? snapshot.order?.customerId : recorded?.order.customerId;
  const names = await customerNames([customerId ?? undefined]);
  return {
    snapshot,
    recorded,
    records,
    customerName: customerId ? (names[customerId] ?? null) : null,
    actor: actor(me),
    role: me.role,
  };
}

/**
 * The socket keeps the live state current, and the records fetcher (below) the D1 records, so the
 * loader (an engine snapshot and D1 reads) runs again only for another order or a navigation, not
 * after an action on this page.
 */
export function shouldRevalidate({
  currentParams,
  nextParams,
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentParams.orderId !== nextParams.orderId) return true;
  // `?node=` only selects a step on the live order; the socket already keeps it current.
  if (
    !formMethod &&
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.search !== nextUrl.search
  )
    return false;
  if (formMethod && formMethod !== 'GET') return false;
  return defaultShouldRevalidate;
}

/** `graph` is a tab only below lg; wider screens show the graph beside the panels. */
type Tab = 'actions' | 'activity' | 'details' | 'node' | 'graph';
type Records = Awaited<ReturnType<typeof orderRecords>>;

/** How often, at most, the order page fetches its D1 records again while the run moves. */
const RECORDS_REFRESH_MS = 1500;

/** Engine reasons arrive without a full stop; banners read as sentences. */
const sentence = (s?: string) => (!s ? '' : /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** Without an engine reason, the end step the run reached says how it finished. */
function finishedAt(s: OrderState): string | undefined {
  const end = s.flow?.nodes
    .filter((n) => n.type.startsWith('control.end') && s.nodes[n.id]?.status === 'succeeded')
    .sort((a, b) => (s.nodes[b.id]?.endedAt ?? 0) - (s.nodes[a.id]?.endedAt ?? 0))[0];
  if (!end) return undefined;
  const path = Object.entries(s.nodes)
    .filter(([, r]) => r.status === 'succeeded' && r.branches?.length)
    .sort((a, b) => (b[1].endedAt ?? 0) - (a[1].endedAt ?? 0))
    .map(([id, r]) => ({ id, branch: r.branches![0]! }))
    .find((x) => ['escalated', 'timeout', 'rejected'].includes(x.branch));
  const why = path
    ? `${s.flow?.nodes.find((n) => n.id === path.id)?.label ?? path.id} ${path.branch === 'rejected' ? 'was rejected' : 'timed out'}`
    : undefined;
  return why ? `${why}, so the flow ended at ${end.label}` : `Ended at ${end.label}`;
}

/** Cancelled because an approval was rejected or timed out: a policy decline, not a human cancel. */
const shownStatus = (s: OrderState) =>
  s.status === 'cancelled' &&
  Object.values(s.nodes).some((n) =>
    n.branches?.some((b) => ['escalated', 'timeout', 'rejected'].includes(b)),
  )
    ? 'declined'
    : s.status;

const rolledBack = (s: OrderState) =>
  !!s.rollback || Object.values(s.nodes).some((n) => n.status === 'rolled_back');

/**
 * Keyed by order: the route stays mounted when it moves to another order (a restart, say), and the
 * live state starts over from that order's snapshot rather than keeping the last one's flow.
 */
export default function OrderPage() {
  const { snapshot, recorded } = useLoaderData<typeof loader>();
  if (!snapshot) return <RecordedOrderView key={recorded!.order.id} />;
  return <OrderView key={snapshot.orderId} />;
}

function OrderView() {
  const canOperate = useCan('operator');
  const {
    snapshot: live,
    records: loadedRecords,
    customerName,
    actor: by,
  } = useLoaderData<typeof loader>();
  // OrderPage shows this only for an order the engine has.
  const snapshot = live!;
  const [state, setState] = useState<OrderState>(snapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(
    snapshot.waits.length || rolledBack(snapshot) ? 'actions' : 'activity',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const orderId = snapshot.orderId!;
  const tabsId = useId();

  const agent = useAgent<OrderState>({
    agent: 'order-agent',
    name: orderId,
    // The broadcast leaves out the pinned flow (the loader's snapshot has it; the agent's
    // `getFlow` serves it) and carries only the newest timeline entries.
    onStateUpdate: (s) =>
      setState((prev) => ({
        ...s,
        flow: s.flow ?? prev.flow,
        timeline: mergeTimeline(prev.timeline, s.timeline),
      })),
  });

  // Payments, shipments and documents live in D1; fetch them again as the run moves, at most every
  // RECORDS_REFRESH_MS and once more after the last change. One fetcher per order, so another
  // order's records never show here.
  const recordsFetcher = useFetcher<Records>({ key: `order-records:${orderId}` });
  const records = recordsFetcher.data ?? loadedRecords;
  const loadRecords = useRef(recordsFetcher.load);
  loadRecords.current = recordsFetcher.load;
  const lastRefresh = useRef(Date.now());
  const seenUpdate = useRef(snapshot.updatedAt);
  useEffect(() => {
    if (state.updatedAt === seenUpdate.current) return;
    const wait = Math.max(0, lastRefresh.current + RECORDS_REFRESH_MS - Date.now());
    const t = window.setTimeout(() => {
      seenUpdate.current = state.updatedAt;
      lastRefresh.current = Date.now();
      void loadRecords.current(`/orders/${orderId}/records`);
    }, wait);
    return () => window.clearTimeout(t);
  }, [state.updatedAt, orderId]);

  // Land on what needs attention: a new wait, or a rollback, brings the Actions tab forward.
  const waitKey = state.waits.map((w) => w.eventType).join('|');
  const prevWaitKey = useRef(waitKey);
  const wasRolled = useRef(rolledBack(state));
  useEffect(() => {
    if (waitKey && waitKey !== prevWaitKey.current) setTab('actions');
    prevWaitKey.current = waitKey;
  }, [waitKey]);
  useEffect(() => {
    const now = rolledBack(state);
    if (now && !wasRolled.current) setTab('actions');
    wasRolled.current = now;
  }, [state]);

  const call = async (label: string, method: string, args: unknown[]) => {
    setBusy(label);
    setError(null);
    try {
      return await agent.call(method, args);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(
        /not waiting/i.test(detail)
          ? 'That step is no longer waiting: someone else decided it, or it timed out.'
          : detail.includes(OWN_ORDER_REFUSAL)
            ? OWN_ORDER_REFUSAL
            : `That did not go through. ${detail}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const order = state.order!;
  const flow = state.flow!;
  const terminal = TERMINAL_ORDER_STATUSES.includes(state.status);
  const node = selected ? flow.nodes.find((n) => n.id === selected) : undefined;
  const issues = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(state.nodes)
          .filter(([, r]) => r.error)
          .map(([id, r]) => [id, r.error!]),
      ),
    [state.nodes],
  );
  const select = (id: string) => {
    setSelected(id);
    setTab('node');
  };
  // A link to a step (`?node=`, e.g. from the assistant) opens it in the inspector.
  const [search] = useSearchParams();
  const linked = search.get('node');
  useEffect(() => {
    if (linked && flow.nodes.some((n) => n.id === linked)) {
      setSelected(linked);
      setTab('node');
    }
  }, [linked, flow.nodes]);
  // Stable, so the canvas doesn't see a new handler on every live update.
  const selectOnCanvas = useCallback((id: string | null) => {
    setSelected(id);
    if (id) setTab('node');
  }, []);
  const assistant = useAssistant();
  const title = order.title || ORDER_MODEL_LABELS[order.model as OrderModel];
  const awaitingApproval = state.waits.some((w) => w.kind === 'approval');
  usePageContext(
    () => ({
      kind: 'order',
      id: orderId,
      label: `${title} ${orderRef(orderId)}`,
      awaitingApproval,
    }),
    [orderId, title, awaitingApproval],
  );

  // Below lg the graph is a tab of its own, so each view has the screen and there's one scroll
  // region at a time rather than a capped panel above a pannable canvas.
  const wide = useMedia(WIDE);
  const shown: Tab = wide && tab === 'graph' ? 'activity' : tab;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    {
      id: 'actions',
      label: state.waits.length
        ? 'Actions'
        : rolledBack(state)
          ? 'Rollback'
          : TERMINAL_ORDER_STATUSES.includes(state.status)
            ? 'Outcome'
            : 'Actions',
      count: state.waits.length || undefined,
    },
    ...(wide ? [] : [{ id: 'graph' as const, label: 'Graph' }]),
    { id: 'activity', label: 'Activity' },
    { id: 'details', label: 'Details' },
    { id: 'node', label: 'Node' },
  ];

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-var(--shell-h))]">
      <header className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b px-4 py-3 sm:px-6">
        {/* A real basis, so the totals and actions wrap below the title on a phone instead of
            squeezing it to a column. */}
        <div className="min-w-0 flex-1 basis-72">
          <div className="caption">
            <Link to="/orders" viewTransition className="hover:text-foreground hover:underline">
              Orders
            </Link>{' '}
            / {ORDER_MODEL_LABELS[order.model as OrderModel]}
          </div>
          {/* A title wraps rather than truncating; the ref stays whole beside its last word. */}
          <h1 className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold tracking-title text-xl leading-tight">
            <span className="vt-order-title min-w-0 [overflow-wrap:anywhere]">
              {order.title || ORDER_MODEL_LABELS[order.model as OrderModel]}{' '}
              <span className="whitespace-nowrap font-mono font-normal text-base text-muted-foreground">
                {orderRef(order.id)}
              </span>
            </span>
            <StatusBadge status={shownStatus(state)} />
          </h1>
          <p className="mt-1 text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {customerName ??
              order.customerId ??
              (order.contact ? `Guest · ${order.contact.email}` : 'No customer')}{' '}
            · {ORDER_CHANNEL_LABELS[order.channel] ?? order.channel}
            {order.fulfillment
              ? ` · ${FULFILLMENT_METHOD_LABELS[order.fulfillment.method]}${typeof state.vars.fulfillmentLocation === 'string' ? ` (${state.vars.fulfillmentLocation})` : ''}`
              : ''}{' '}
            · {flow.name} v{flow.version}
            {state.generation > 1 ? ` · run ${state.generation}` : ''} ·{' '}
            <span className="select-all font-mono">{order.id}</span>
          </p>
        </div>
        {/* Wraps as a whole rather than clipping: on a phone the actions fit beside the totals
            because Cancel order folds into the ⋯ menu below md. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="text-right">
            <div className="font-semibold text-lg tabular">
              {money(order.total, order.currency)}
            </div>
            <div className="whitespace-nowrap text-muted-foreground text-xs tabular">
              {plural(order.lines.length, 'line')} · tax {money(order.tax, order.currency)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                assistant.setScope('page');
                assistant.focus();
              }}
              title="Ask the assistant about this order"
            >
              <MessageSquareText /> Ask
            </Button>
            <ShareButton title={`${title} ${orderRef(order.id)}`} />
            {!terminal && canOperate ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="hidden md:inline-flex"
                  disabled={!!busy || cancelling}
                  onClick={() => setCancelling(true)}
                >
                  <CircleSlash /> Cancel order
                </Button>
                <OrderMenu disabled={!!busy || cancelling} onCancel={() => setCancelling(true)} />
              </>
            ) : null}
          </div>
        </div>
      </header>

      {cancelling && !terminal ? (
        <CancelPanel
          busy={busy === 'cancel'}
          onKeep={() => setCancelling(false)}
          onCancel={async (reason) => {
            await call('cancel', 'cancel', [reason]);
            setCancelling(false);
          }}
        />
      ) : null}

      {terminal ? (
        <div
          className="flex items-start gap-2 border-b px-4 py-2 text-sm sm:px-6"
          style={{
            color: statusColor(shownStatus(state)),
            background: `color-mix(in oklch, ${statusColor(shownStatus(state))} 7%, transparent)`,
          }}
        >
          {state.status === 'rolled_back' ? (
            <Undo2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : null}
          <p className="max-w-[75ch]">
            <span className="font-medium">{humanize(shownStatus(state))}.</span>{' '}
            {sentence(state.reason ? readableReason(state.reason) : finishedAt(state))}
            {state.rollback
              ? state.rollback.outcome === 'complete'
                ? ' Every completed step that can be undone was reversed.'
                : ' Some steps could not be reversed; see Rollback.'
              : ''}
          </p>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        <aside className="flex min-h-0 flex-col lg:col-start-2 lg:row-start-1 lg:border-l">
          <div
            role="tablist"
            aria-label="Order panels"
            className="sticky top-[var(--shell-h)] z-10 flex gap-1 overflow-x-auto border-b bg-background px-3 pt-2 [scrollbar-width:none] lg:static"
            onKeyDown={(e) => {
              const i = tabs.findIndex((t) => t.id === shown);
              const next =
                e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : undefined;
              if (next === undefined) return;
              e.preventDefault();
              const t = tabs[(next + tabs.length) % tabs.length]!;
              setTab(t.id);
              document.getElementById(`${tabsId}-${t.id}`)?.focus();
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                id={`${tabsId}-${t.id}`}
                type="button"
                role="tab"
                aria-selected={shown === t.id}
                aria-controls={`${tabsId}-${t.id === 'graph' ? 'graph-panel' : 'panel'}`}
                tabIndex={shown === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={cn(
                  '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 py-2 font-medium text-ui text-muted-foreground hover:text-foreground',
                  shown === t.id && 'border-foreground text-foreground',
                )}
              >
                {t.label}
                {t.count ? (
                  <span className="rounded-full bg-wait/15 px-1.5 py-px text-2xs text-wait tabular">
                    {t.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-3 border-b bg-bad/10 px-4 py-2 text-bad text-sm"
            >
              <p className="flex-1">{error}</p>
              <button type="button" className="text-xs underline" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          <div
            id={`${tabsId}-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-${shown}`}
            hidden={shown === 'graph'}
            className="min-h-0 flex-1 p-4 lg:overflow-y-auto"
          >
            {/* Stays mounted while hidden so an open undo window survives a tab switch. What waits
                on a person comes first, then what a rollback undid. */}
            <div hidden={shown !== 'actions'} className="space-y-4">
              <Actions
                state={state}
                busy={busy}
                call={call}
                by={by}
                onSelect={select}
                sellers={records.sellers}
                messages={records.messages}
                onActivity={() => setTab('activity')}
              />
              <Compensation state={state} records={records} onSelect={select} />
            </div>
            {shown === 'activity' ? <Activity state={state} onSelect={select} /> : null}
            {shown === 'details' ? <Details state={state} records={records} /> : null}
            {shown === 'node' ? (
              node ? (
                <Inspector node={node} run={state.nodes[node.id]} />
              ) : (
                <Empty icon={<MousePointerClick aria-hidden="true" />}>
                  Select a step on the graph to see its settings and last result.
                </Empty>
              )
            ) : null}
          </div>
        </aside>
        {wide || shown === 'graph' ? (
          <div
            id={`${tabsId}-graph-panel`}
            {...(wide ? {} : { role: 'tabpanel', 'aria-labelledby': `${tabsId}-graph` })}
            className="h-[calc(100dvh-var(--shell-h)-var(--tabbar-h)-3rem)] min-h-[320px] p-3 sm:p-4 lg:col-start-1 lg:row-start-1 lg:h-auto"
          >
            <FlowCanvas
              graph={flow}
              runs={state.nodes}
              edgeStates={state.edges}
              issues={issues}
              selectedId={selected}
              onSelect={selectOnCanvas}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Below md the header's destructive action sits in a ⋯ menu, as a row's do on Team, so the title,
 * totals and the everyday actions keep a phone's width. Picking it opens the same Cancel panel.
 */
function OrderMenu({ disabled, onCancel }: { disabled: boolean; onCancel: () => void }) {
  // The panel opens once the menu has closed: opened while the menu still holds focus, its reason
  // field's autofocus is taken back as the menu closes.
  const picked = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="md:hidden"
          aria-label="More order actions"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (!picked.current) return;
          picked.current = false;
          e.preventDefault();
          onCancel();
        }}
      >
        <DropdownMenuItem
          className="touch:min-h-11"
          variant="destructive"
          disabled={disabled}
          onSelect={() => {
            picked.current = true;
          }}
        >
          <CircleSlash aria-hidden="true" /> Cancel order…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CancelPanel({
  busy,
  onKeep,
  onCancel,
}: {
  busy: boolean;
  onKeep: () => void;
  onCancel: (reason: string) => void;
}) {
  const [reason, setReason] = useState('Customer cancelled');
  const id = useId();
  return (
    <form
      className="flex flex-wrap items-end gap-3 border-b bg-bad/[0.05] px-4 py-3 sm:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onCancel(reason.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onKeep();
      }}
    >
      <Field className="min-w-0 flex-1 basis-72 gap-2">
        <div>
          <p className="font-medium text-sm">Cancel this order?</p>
          <FieldDescription className="text-xs">
            The flow stops, and completed steps that can be undone (reservations, card
            authorizations, shipments) are reversed.
          </FieldDescription>
        </div>
        <FieldLabel htmlFor={id} className="caption">
          Reason, kept in the order history
        </FieldLabel>
        <Input
          id={id}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="h-8 max-w-md"
          autoFocus
        />
      </Field>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onKeep}>
          Keep order
        </Button>
        <Button type="submit" variant="destructive" size="sm" disabled={busy || !reason.trim()}>
          {busy ? 'Cancelling…' : 'Cancel order'}
        </Button>
      </div>
    </form>
  );
}

type Call = (label: string, method: string, args: unknown[]) => Promise<unknown>;

/** The rollback as a ledger: what failed, then each reversed step in the order it was undone. */
function Compensation({
  state,
  records,
  onSelect,
}: {
  state: OrderState;
  records: Records;
  onSelect: (id: string) => void;
}) {
  if (!rolledBack(state)) return null;
  const flow = state.flow!;
  const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
  const undoneAt = new Map(
    state.timeline.filter((t) => t.kind === 'rollback' && t.nodeId).map((t) => [t.nodeId!, t.at]),
  );
  const reversed = Object.entries(state.nodes)
    .filter(([, r]) => r.status === 'rolled_back')
    .sort((a, b) => (undoneAt.get(a[0]) ?? 0) - (undoneAt.get(b[0]) ?? 0));
  // A compensation that found nothing to undo ("Released 0 reservations") reversed nothing.
  const noop = (summary?: string) =>
    /^(Released|Voided) 0 |^No shipment to cancel/.test(summary ?? '');
  const undone = reversed.filter(([, r]) => !noop(r.summary)).length;
  const currency = state.order?.currency;
  const cause = Object.entries(state.nodes).find(([, r]) => r.status === 'failed');
  const voided = records.payments
    .filter((p) => p.status === 'voided')
    .reduce((s, p) => s + p.amount, 0);
  const failed = state.rollback?.outcome === 'failed';

  // A region of its own, so the rollback and what to do next read as one part of the panel.
  return (
    <section aria-labelledby="rollback-title" className="space-y-4">
      <Section
        title={
          <span id="rollback-title" className="flex items-center gap-2">
            <Undo2 className="size-4 text-undo" aria-hidden="true" />
            {failed ? 'Rollback incomplete' : state.rollback ? 'Rolled back' : 'Rolling back'}
          </span>
        }
        description={
          cause ? (
            <>
              Stopped at{' '}
              <button
                type="button"
                className="font-medium text-link hover:underline"
                onClick={() => onSelect(cause[0])}
              >
                {label(cause[0])}
              </button>
              {cause[1].error ? <span>: {clip(cause[1].error)}</span> : null}
            </>
          ) : state.reason ? (
            sentence(readableReason(state.reason))
          ) : undefined
        }
      >
        <Table edge="flush" caption="Steps reversed, in the order they were undone">
          <TableHead>
            <Tr>
              <Th>Step</Th>
              <Th>Reversed</Th>
            </Tr>
          </TableHead>
          <TableBody>
            {reversed.length ? (
              reversed.map(([id, r]) => (
                <Tr key={id}>
                  <Td className="py-2">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => onSelect(id)}
                    >
                      {label(id)}
                    </button>
                  </Td>
                  <Td className="py-2 text-muted-foreground">
                    {noop(r.summary) ? 'Nothing to undo yet' : (r.summary ?? 'Reversed')}
                  </Td>
                </Tr>
              ))
            ) : (
              <Tr>
                <Td colSpan={2} className="py-2 text-muted-foreground">
                  Nothing had been done that needed undoing.
                </Td>
              </Tr>
            )}
          </TableBody>
          <TableFoot>
            <Tr className="double-rule border-t">
              <Td className="pt-2 font-medium">
                {undone ? `${plural(undone, 'step')} reversed` : 'Nothing needed undoing'}
              </Td>
              <Td numeric className="pt-2 font-medium">
                {voided ? `${money(voided, currency)} released to the card` : ''}
              </Td>
            </Tr>
          </TableFoot>
        </Table>
        {failed ? (
          <p className="mt-3 text-bad text-sm">
            {state.rollback?.error ? `${state.rollback.error}. ` : ''}Check Payments and Shipments
            under Details and settle what is left by hand.
          </p>
        ) : null}
      </Section>
      {state.rollback ? (
        <NextSteps orderId={state.orderId!} customer={state.order?.customerId} />
      ) : null}
    </section>
  );
}

/** After a rollback: try again with the same lines, or look at what blocked it. */
function NextSteps({ orderId, customer }: { orderId: string; customer?: string }) {
  const restart = useFetcher<{ ok: boolean; orderId?: string; error?: string }>();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const canOperate = useCan('operator');
  useEffect(() => {
    if (restart.state === 'idle' && restart.data?.orderId)
      navigate(`/orders/${restart.data.orderId}`);
  }, [restart.state, restart.data, navigate]);
  return (
    <Section
      title="Next"
      description={
        <>
          The new order runs on the flow’s current version; this one stays as it is, for the record.
          To see what blocked it,{' '}
          <Link to="/commerce" className="text-link hover:underline">
            check stock and credit
          </Link>
          .
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <restart.Form
            method="post"
            action={`/orders/${orderId}/action`}
            className="flex flex-wrap items-center gap-2"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirming(false);
            }}
          >
            <input type="hidden" name="intent" value="restart" />
            <span className="text-sm">
              Start a new order{customer ? ' for the same customer' : ''} with these lines?
            </span>
            <Button size="sm" disabled={restart.state !== 'idle'}>
              {restart.state !== 'idle' ? 'Starting…' : 'Start new order'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Not now
            </Button>
          </restart.Form>
        ) : canOperate ? (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            <RotateCcw /> Start again with the same lines
          </Button>
        ) : null}
      </div>
      {restart.data?.error ? (
        <p className="mt-2 text-bad text-sm" role="alert">
          {restart.data.error}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * A finished order's ending. The banner above says how it ended and why; this says where, the path
 * it took, and who was told, so the last thing an operator sees is a summary rather than a gap.
 */
function Outcome({
  state,
  messages,
  onSelect,
  onActivity,
}: {
  state: OrderState;
  messages: Records['messages'];
  onSelect: (id: string) => void;
  onActivity: () => void;
}) {
  const formatTime = useDateTime();
  const flow = state.flow!;
  const end = flow.nodes
    .filter((n) => n.type.startsWith('control.end') && state.nodes[n.id]?.status === 'succeeded')
    .sort((a, b) => (state.nodes[b.id]?.endedAt ?? 0) - (state.nodes[a.id]?.endedAt ?? 0))[0];
  const endedAt = end ? state.nodes[end.id]?.endedAt : undefined;
  const runs = Object.values(state.nodes);
  const ran = runs.filter((r) => !['pending', 'skipped'].includes(r.status)).length;
  const skipped = runs.filter((r) => r.status === 'skipped').length;
  return (
    <>
      <Section title="Where it ended">
        <Facts>
          <Fact label="Final step">
            {end ? (
              <button
                type="button"
                className="text-left font-medium underline-offset-2 hover:underline"
                onClick={() => onSelect(end.id)}
              >
                {end.label}
              </button>
            ) : (
              'Stopped before reaching an end step.'
            )}
          </Fact>
          {endedAt ? <Fact label="Ended">{formatTime(endedAt)}</Fact> : null}
          <Fact label="Steps">
            <span className="tabular">
              {plural(ran, 'step')} ran, {skipped} skipped
            </span>
          </Fact>
          <Fact label="Flow">
            {flow.name} v{flow.version}
          </Fact>
        </Facts>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onActivity}>
            See every step
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/flows/${flow.id}`}>Open the flow</Link>
          </Button>
        </div>
      </Section>
      <Section title="Who was told">
        {messages.length ? (
          <ul className="-mx-2 flex flex-col gap-1">
            {messages.map((m) => (
              <Item key={m.id} asChild size="xs" className="items-start px-2">
                <li>
                  <ItemMedia variant="icon" className="mt-0.5 text-muted-foreground">
                    <Mail aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none font-normal">{m.subject}</ItemTitle>
                    <ItemDescription className="text-xs">{m.recipient}</ItemDescription>
                  </ItemContent>
                </li>
              </Item>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No one was sent a notice.</p>
        )}
      </Section>
    </>
  );
}

/** Facts as label and value: a label column sized to its longest label, the values beside it. */
function Facts({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">{children}</dl>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

function Actions({
  state,
  busy,
  call,
  by,
  onSelect,
  sellers,
  messages,
  onActivity,
}: {
  state: OrderState;
  busy: string | null;
  call: Call;
  by: string;
  onSelect: (id: string) => void;
  sellers: Records['sellers'];
  messages: Records['messages'];
  onActivity: () => void;
}) {
  const canApprove = useCan('approver');
  const canOperate = useCan('operator');
  const formatTime = useDateTime();
  if (!state.waits.length) {
    if (rolledBack(state)) return null;
    if (TERMINAL_ORDER_STATUSES.includes(state.status))
      return (
        <Outcome state={state} messages={messages} onSelect={onSelect} onActivity={onActivity} />
      );
    return (
      <Empty icon={<Workflow aria-hidden="true" />}>
        Nothing is waiting on a person or an outside event. The flow is running on its own.
      </Empty>
    );
  }
  const label = (id: string) => state.flow?.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <Section
      title="Waiting"
      description="The order is paused at these steps until a person or an outside event answers."
    >
      <ul className="flex flex-col gap-2">
        {state.waits.map((w) => (
          <Item key={w.eventType} asChild variant="muted" size="sm" className="items-start">
            <li>
              <ItemHeader className="text-xs">
                <span className="flex items-center gap-2 text-wait">
                  <StatusDot status="waiting" />
                  {w.kind === 'approval'
                    ? `Approval for ${assigneeLabel(w.assignee) || 'anyone'}`
                    : 'Waiting for an outside event'}
                </span>
                <span className="whitespace-nowrap text-muted-foreground">
                  since <Ago ms={w.since} />
                </span>
              </ItemHeader>
              <ItemContent className="min-w-0">
                <ItemTitle className="line-clamp-none">
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => onSelect(w.nodeId)}
                  >
                    {label(w.nodeId)}
                  </button>
                </ItemTitle>
                {w.kind === 'approval' ? (
                  <DecisionContext ctx={approvalContext(state, w.nodeId)} />
                ) : (
                  <>
                    <p className="text-muted-foreground text-xs">
                      Waiting for {eventWaiting(w.event!)}
                      {w.deadline ? `; times out ${formatTime(w.deadline)}` : ''}.
                    </p>
                    {/* Connected systems send the event themselves; the API detail is for developers. */}
                    <details className="group text-muted-foreground text-xs">
                      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
                        <ChevronRight
                          className="size-3.5 transition-transform group-open:rotate-90"
                          aria-hidden="true"
                        />
                        For developers
                      </summary>
                      <p className="mt-1">
                        Systems send <span className="font-mono text-foreground">{w.event}</span> to{' '}
                        <span className="break-all font-mono">
                          POST /api/v1/orders/{state.orderId}/events
                        </span>
                        .
                      </p>
                    </details>
                  </>
                )}
              </ItemContent>
              {w.kind === 'approval' ? (
                <ItemFooter className="block">
                  {canApprove ? (
                    <DecisionControls
                      deadline={w.deadline}
                      onTimeout={approvalContext(state, w.nodeId).onTimeout}
                      busy={busy === 'decide'}
                      disabled={!!busy}
                      onDecide={(decision, note) =>
                        void call('decide', 'decide', [w.nodeId, decision, by, note || undefined])
                      }
                      onFlush={(decision, note) =>
                        sendDecision(state.orderId!, w.nodeId, decision, note)
                      }
                    />
                  ) : (
                    <p className="text-muted-foreground text-xs">An approver decides this.</p>
                  )}
                </ItemFooter>
              ) : canOperate && w.event === 'seller.responded' ? (
                <ItemFooter className="block">
                  <ul className="space-y-1.5">
                    {sellers
                      .filter((s) => s.status === 'pending')
                      .map((s) => (
                        <li key={s.sellerId} className="flex flex-wrap items-center gap-1.5">
                          <span className="mr-auto text-xs">{s.name}</span>
                          {(['accepted', 'rejected'] as const).map((decision) => (
                            <Button
                              key={decision}
                              size="sm"
                              variant="outline"
                              disabled={!!busy}
                              onClick={() =>
                                call('event', 'deliver', [
                                  w.event,
                                  { source: 'dashboard', sellerId: s.sellerId, decision },
                                ])
                              }
                            >
                              <Zap /> {decision === 'accepted' ? 'Accepts' : 'Rejects'}
                            </Button>
                          ))}
                        </li>
                      ))}
                  </ul>
                </ItemFooter>
              ) : canOperate ? (
                <ItemActions className="basis-full">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() =>
                      call('event', 'deliver', [
                        w.event,
                        { source: 'dashboard', amount: state.order?.total },
                      ])
                    }
                  >
                    {eventAction(w.event!)}
                  </Button>
                </ItemActions>
              ) : null}
            </li>
          </Item>
        ))}
      </ul>
    </Section>
  );
}

// An event line is detail, not a link: it reads muted like any step's.
const KIND_TONE: Record<string, string> = {
  approval: 'text-wait',
  event: 'text-muted-foreground',
  ai: 'text-ai',
  rollback: 'text-undo',
  order: 'text-foreground',
  node: 'text-muted-foreground',
};

function Activity({ state, onSelect }: { state: OrderState; onSelect: (id: string) => void }) {
  const formatTime = useDateTime();
  // Keyed by what each entry says, not its place: the newest is on top, so places shift. Repeats
  // are numbered oldest first, so an entry's key never changes as more arrive.
  const repeats = new Map<string, number>();
  const items = state.timeline
    .map((t) => {
      const said = `${t.at}:${t.kind}:${t.nodeId ?? ''}:${t.message}`;
      const n = (repeats.get(said) ?? 0) + 1;
      repeats.set(said, n);
      return { t, key: `${said}#${n}` };
    })
    .reverse();
  // What happens while the order is open arrives on top with the shared rise.
  const arrived = useArrivals(items.map((i) => i.key));
  const start = state.timeline[0]?.at ?? 0;
  const label = (id: string) => state.flow?.nodes.find((n) => n.id === id)?.label ?? id;
  if (!items.length) return <Empty>Nothing has happened yet.</Empty>;
  // Quiet rows, read one at a time: the time since the order started, then what happened.
  return (
    <Section title="Timeline" description="What happened on this order, newest first.">
      <ol className="-mx-2 flex flex-col">
        {items.map(({ t, key }) => (
          <Item
            key={key}
            asChild
            size="xs"
            className={cn('items-start gap-3 px-2 py-1.5', arrived(key) && 'animate-arrive')}
          >
            <li>
              <ItemMedia className="w-14 justify-end self-start">
                <time
                  dateTime={new Date(t.at).toISOString()}
                  title={formatTime(t.at)}
                  className="pt-px text-muted-foreground text-xs tabular"
                >
                  {offset(t.at, start)}
                </time>
              </ItemMedia>
              <ItemContent className={cn('min-w-0 text-sm', KIND_TONE[t.kind])}>
                <span>
                  {t.nodeId ? (
                    <button
                      type="button"
                      className="mr-1.5 font-medium text-foreground hover:underline"
                      onClick={() => onSelect(t.nodeId!)}
                    >
                      {label(t.nodeId)}
                    </button>
                  ) : null}
                  {t.nodeId
                    ? plainLog(t.message.replace(`${label(t.nodeId)}: `, ''), label(t.nodeId))
                    : plainLog(t.message)}
                </span>
              </ItemContent>
            </li>
          </Item>
        ))}
      </ol>
    </Section>
  );
}

function Details({ state, records }: { state: OrderState; records: Records }) {
  const o = state.order!;
  return (
    <div className="space-y-4">
      <Section title="Lines" flush>
        {o.lines.length ? (
          <Table caption="Lines">
            <TableHead>
              <Tr>
                <Th>Item</Th>
                <Th numeric>Qty</Th>
                <Th numeric>Amount</Th>
              </Tr>
            </TableHead>
            <TableBody>
              {o.lines.map((l) => (
                <Tr key={l.sku}>
                  <Td>
                    {l.name ?? l.sku}
                    {l.name ? (
                      <span className="ml-1.5 font-mono text-muted-foreground text-xs">
                        {l.sku}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>{l.qty}</Td>
                  <Td numeric>
                    {l.unitPrice !== undefined ? money(l.unitPrice * l.qty, o.currency) : '—'}
                  </Td>
                </Tr>
              ))}
            </TableBody>
            <TableFoot>
              {o.shipping || o.shippingOption ? (
                <Tr className="border-t">
                  <Td colSpan={2} className="text-muted-foreground">
                    Shipping
                    {o.shippingOption ? (
                      <span className="ml-1.5 font-mono text-xs">{o.shippingOption}</span>
                    ) : null}
                  </Td>
                  <Td numeric>{money(o.shipping ?? 0, o.currency)}</Td>
                </Tr>
              ) : null}
              <Tr className={o.shipping || o.shippingOption ? undefined : 'border-t'}>
                <Td colSpan={2} className="text-muted-foreground">
                  Tax
                </Td>
                <Td numeric>{money(o.tax, o.currency)}</Td>
              </Tr>
              <Tr className="double-rule">
                <Td colSpan={2} className="font-medium">
                  Total
                </Td>
                <Td numeric className="font-semibold">
                  {money(o.total, o.currency)}
                </Td>
              </Tr>
            </TableFoot>
          </Table>
        ) : (
          <p className="px-5 py-4 text-muted-foreground text-sm">No lines yet.</p>
        )}
      </Section>
      <RecordSections records={records} currency={o.currency} />
      <Card size="sm" className="gap-0 py-0">
        <details className="group">
          <summary className="caption flex cursor-pointer list-none items-center gap-1 px-(--card-spacing) py-3 hover:text-foreground">
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Flow variables (for debugging)
          </summary>
          <CardContent className="pb-(--card-spacing)">
            <pre className="overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
              {JSON.stringify(state.vars, null, 2)}
            </pre>
          </CardContent>
        </details>
      </Card>
    </div>
  );
}

/** What the order's steps wrote to D1: documents, money, sellers, shipments and messages. */
function RecordSections({ records, currency }: { records: Records; currency: string }) {
  return (
    <>
      {records.documents.length || records.invoices.length ? (
        <Section title="Documents">
          <ul className="-mx-2 flex flex-col gap-1">
            {records.invoices.map((inv) => (
              <Item
                key={inv.id}
                asChild
                size="xs"
                className={cn('relative px-2', inv.hostedUrl && 'hover:bg-muted/60')}
              >
                <li>
                  <ItemMedia variant="icon" className="text-muted-foreground">
                    {inv.hostedUrl ? (
                      <ExternalLink aria-hidden="true" />
                    ) : (
                      <FileText aria-hidden="true" />
                    )}
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none">
                      {inv.hostedUrl ? (
                        <a
                          href={inv.hostedUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-link after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                        >
                          Stripe invoice{inv.number ? ` ${inv.number}` : ''}
                        </a>
                      ) : (
                        <>Stripe invoice{inv.number ? ` ${inv.number}` : ''}</>
                      )}
                    </ItemTitle>
                    <ItemDescription className="text-xs">
                      {humanize(inv.status)} · {money(inv.amount, inv.currency)}
                    </ItemDescription>
                  </ItemContent>
                </li>
              </Item>
            ))}
            {records.documents.map((d) => (
              <Item key={d.id} asChild size="xs" className="relative px-2 hover:bg-muted/60">
                <li>
                  <ItemMedia variant="icon" className="text-muted-foreground">
                    <FileText aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
                      <a
                        href={`/docs/${d.r2Key}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                      >
                        {humanize(d.kind)} · {d.r2Key.split('/').pop()}
                      </a>
                    </ItemTitle>
                  </ItemContent>
                </li>
              </Item>
            ))}
          </ul>
        </Section>
      ) : null}
      <Ledger
        title="Payments"
        rows={records.payments.map((p) => [
          humanize(p.kind),
          humanize(p.status),
          money(p.amount, currency),
        ])}
      />
      <Ledger
        title="Sellers"
        rows={records.sellers.map((s) => [
          s.name,
          s.reason ? `${humanize(s.status)}: ${s.reason}` : humanize(s.status),
          money(s.subtotal, currency),
        ])}
      />
      <Ledger
        title="Seller payouts"
        rows={records.payouts.map((p) => [
          `${p.name ?? p.sellerId} (${money(p.commission, currency)} commission)`,
          humanize(p.status),
          money(p.net, currency),
        ])}
      />
      <Ledger
        title="Shipments"
        rows={records.shipments.map((s) => [
          `${s.carrier.toUpperCase()} ${s.tracking}`,
          humanize(s.status),
          '',
        ])}
      />
      <Ledger
        title="Messages sent"
        rows={records.messages.map((m) => [m.subject, m.recipient, ''])}
      />
    </>
  );
}

/** A record as a flush table in its own card: rows to compare, figures on the right. */
function Ledger({ title, rows }: { title: string; rows: [string, string, string][] }) {
  if (!rows.length) return null;
  return (
    <Section title={title} flush>
      <Table caption={title}>
        <TableBody>
          {rows.map((r, i) => (
            <Tr key={`${title}-${i}`}>
              <Td>{r[0]}</Td>
              <Td className="text-muted-foreground">{r[1]}</Td>
              <Td numeric>{r[2]}</Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

/**
 * How a recorded order ended, after its status: "Rolled back: insufficient stock." A reason that
 * already starts with the status ("Cancelled by the customer") stands alone, and one with its own
 * colon follows a full stop so it doesn't read as a list.
 */
function endedAs(status: string, reason: string | null) {
  const head = humanize(status);
  if (!reason?.trim()) return `${head}.`;
  if (reason.toLowerCase().startsWith(head.toLowerCase())) return sentence(reason);
  if (reason.includes(':')) return `${head}. ${sentence(reason)}`;
  // Lower-case an ordinary first word only; "ERP" and "3-D Secure" keep theirs.
  const lead = /^[A-Z][a-z]+\b/.test(reason) ? reason[0]!.toLowerCase() + reason.slice(1) : reason;
  return `${head}: ${sentence(lead)}`;
}

/**
 * An order with no run in the engine: the header, how it ended or what it waits on, its flow
 * coloured by the steps D1 recorded with the path it took, what a rollback undid, and its approvals
 * and records. Nothing here acts on it.
 */
function RecordedOrderView() {
  const { recorded, records, customerName } = useLoaderData<typeof loader>();
  const { order: o, flow, runs, edges, steps, approvals, reversed } = recorded!;
  const wide = useMedia(WIDE);
  const [graphOpen, setGraphOpen] = useState(false);
  const terminal = TERMINAL_ORDER_STATUSES.includes(o.status as never);
  const cause = steps.findLast((st) => st.status === 'failed');
  return (
    <div className="flex flex-col lg:h-[calc(100dvh-var(--shell-h))]">
      <header className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1 basis-72">
          <div className="caption">
            <Link to="/orders" viewTransition className="hover:text-foreground hover:underline">
              Orders
            </Link>{' '}
            / {ORDER_MODEL_LABELS[o.model as OrderModel]}
          </div>
          <h1 className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold tracking-title text-xl leading-tight">
            <span className="vt-order-title min-w-0 [overflow-wrap:anywhere]">
              {o.title || ORDER_MODEL_LABELS[o.model as OrderModel]}{' '}
              <span className="whitespace-nowrap font-mono font-normal text-base text-muted-foreground">
                {orderRef(o.id)}
              </span>
            </span>
            <StatusBadge status={o.status} />
          </h1>
          <p className="mt-1 text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {customerName ??
              o.customerId ??
              (o.contactEmail ? `Guest · ${o.contactEmail}` : 'No customer')}{' '}
            · {ORDER_CHANNEL_LABELS[o.channel as keyof typeof ORDER_CHANNEL_LABELS] ?? o.channel}
            {flow ? ` · ${flow.name} v${flow.version}` : ''} ·{' '}
            <span className="select-all font-mono">{o.id}</span>
          </p>
        </div>
        <div className="text-right">
          <div className="font-semibold text-lg tabular">{money(o.total, o.currency)}</div>
          <div className="text-muted-foreground text-xs tabular">
            Started <Ago ms={o.createdAt} />
          </div>
        </div>
      </header>

      {/* One block: that this is a record, how the order ended, in its status colour once it has. */}
      <div
        className={cn('border-b px-4 py-2 text-sm sm:px-6', !terminal && 'bg-muted/40')}
        style={
          terminal
            ? { background: `color-mix(in oklch, ${statusColor(o.status)} 7%, transparent)` }
            : undefined
        }
      >
        <p className="max-w-[75ch]">
          <span
            className="font-medium"
            style={{ color: terminal ? statusColor(o.status) : undefined }}
          >
            Recorded order
            {terminal ? ` · ${endedAs(o.status, o.reason && readableReason(o.reason))}` : '.'}
          </span>{' '}
          <span className="text-foreground/75">
            The engine has no run for it, so this is what the database kept. There is no live state
            to act on.
          </span>
        </p>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* What it waits on first, then what a rollback undid, then the record of every step. */}
        <aside className="min-h-0 space-y-4 p-4 text-sm lg:col-start-2 lg:row-start-1 lg:overflow-y-auto lg:border-l">
          {!terminal && o.waitingOn ? (
            <Section title="Waiting">
              <Item variant="muted" size="sm" className="items-start">
                <ItemMedia className="mt-1.5 self-start">
                  <StatusDot status="waiting" />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none font-normal">{o.waitingOn}</ItemTitle>
                  {o.waitingSince ? (
                    <ItemDescription className="text-xs">
                      {o.waitingAt ? `At ${o.waitingAt} · ` : ''}since <Ago ms={o.waitingSince} />
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Section>
          ) : null}
          {!wide && flow ? (
            <Button variant="outline" size="sm" onClick={() => setGraphOpen((v) => !v)}>
              {graphOpen ? 'Hide the flow' : 'Show the flow'}
            </Button>
          ) : null}
          {reversed ? <RecordedRollback reversed={reversed} cause={cause} /> : null}
          <Section title="Steps" flush>
            {steps.length ? (
              <Table caption="Steps">
                <TableHead>
                  <Tr>
                    <Th>Step</Th>
                    <Th>Result</Th>
                    <Th numeric>Took</Th>
                  </Tr>
                </TableHead>
                <TableBody>
                  {steps.map((st) => (
                    <Tr key={`${st.nodeId}-${st.startedAt}`}>
                      <Td>{st.label}</Td>
                      <Td>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5',
                            st.status === 'rolled_back' && 'text-undo',
                          )}
                        >
                          <StatusDot status={st.status} />
                          {st.status === 'rolled_back' ? 'Reversed' : humanize(st.status)}
                        </span>
                      </Td>
                      <Td numeric className="text-muted-foreground">
                        {duration(st.durationMs)}
                      </Td>
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="px-5 py-4 text-muted-foreground">No steps recorded.</p>
            )}
          </Section>
          {approvals.length ? (
            <Ledger
              title="Approvals"
              rows={approvals.map((a) => [
                a.title,
                a.decidedBy ? `${humanize(a.status)} by ${a.decidedBy}` : humanize(a.status),
                a.amount !== null ? money(a.amount, o.currency) : '',
              ])}
            />
          ) : null}
          <RecordSections records={records} currency={o.currency} />
        </aside>
        {flow && (wide || graphOpen) ? (
          <div className="h-[60dvh] min-h-[320px] p-3 sm:p-4 lg:col-start-1 lg:row-start-1 lg:h-auto">
            <FlowCanvas graph={flow.graph} runs={runs} edgeStates={edges} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a rolled-back recorded order's records show was undone, step by step, as the live view's
 * rollback reads. Generated orders often recorded no reversals at all; that is said, not guessed.
 */
function RecordedRollback({
  reversed,
  cause,
}: {
  reversed: { nodeId: string; label: string; text: string }[];
  cause?: { label: string };
}) {
  return (
    <section aria-labelledby="recorded-rollback-title">
      <Section
        title={
          <span id="recorded-rollback-title" className="flex items-center gap-2">
            <Undo2 className="size-4 text-undo" aria-hidden="true" />
            Rolled back
          </span>
        }
        description={
          cause ? (
            <>
              Stopped at <span className="font-medium text-foreground">{cause.label}</span>
            </>
          ) : undefined
        }
      >
        {reversed.length ? (
          <Table edge="flush" caption="Steps the records show were reversed">
            <TableHead>
              <Tr>
                <Th>Step</Th>
                <Th>Reversed</Th>
              </Tr>
            </TableHead>
            <TableBody>
              {reversed.map((r) => (
                <Tr key={r.nodeId}>
                  <Td className="py-2">{r.label}</Td>
                  <Td className="py-2 text-muted-foreground">{r.text}</Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground">Reversals weren’t recorded for this order.</p>
        )}
      </Section>
    </section>
  );
}
