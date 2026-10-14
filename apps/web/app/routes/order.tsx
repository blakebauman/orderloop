/**
 * The live order page. The loader renders a snapshot; in the browser, `useAgent` connects to the
 * order's OrderAgent (proxied by workers/app.ts) and every state change it broadcasts re-renders
 * the graph, waits and timeline. Actions are agent RPC calls over the same socket. Questions about
 * the order go to the assistant panel, which this page tells which order it is on.
 */

import {
  FULFILLMENT_METHOD_LABELS,
  ORDER_CHANNEL_LABELS,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { useAgent } from 'agents/react';
import {
  ChevronRight,
  CircleSlash,
  FileText,
  MessageSquareText,
  RotateCcw,
  Undo2,
  Zap,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { data, Link, useFetcher, useLoaderData, useNavigate, useRevalidator } from 'react-router';
import { Ago } from '~/components/ago';
import { DecisionContext, DecisionControls, sendDecision } from '~/components/decision';
import { FlowCanvas } from '~/components/flow-canvas';
import { Inspector } from '~/components/inspector';
import { Empty } from '~/components/page';
import { StatusBadge, StatusDot } from '~/components/status';
import { approvalContext } from '~/lib/approvals';
import { useAssistant, usePageContext } from '~/lib/assistant';
import { actor, requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { humanize, money, offset, orderRef, plainLog, plural, statusColor } from '~/lib/format';
import { customerNames, orderRecords } from '~/lib/orders.server';
import { useDateTime } from '~/lib/use-date-time';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/order';

export const meta = ({ loaderData: d, params }: Route.MetaArgs) => [
  {
    title: `${d?.snapshot.order?.title || (d?.snapshot.order ? ORDER_MODEL_LABELS[d.snapshot.order.model as OrderModel] : 'Order')} ${orderRef(params.orderId)} · OrderLoop`,
  },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const snapshot = await engine().snapshot(params.orderId);
  if (!snapshot) throw data('Order not found', { status: 404 });
  const [records, names] = await Promise.all([orderRecords(params.orderId), customerNames()]);
  const customerId = snapshot.order?.customerId;
  return {
    snapshot,
    records,
    customerName: customerId ? (names[customerId] ?? null) : null,
    actor: actor(me),
    role: me.role,
  };
}

type Tab = 'actions' | 'activity' | 'details' | 'node';
type Records = Awaited<ReturnType<typeof orderRecords>>;

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

export default function OrderPage() {
  const canOperate = useCan('operator');
  const { snapshot, records, customerName, actor: by } = useLoaderData<typeof loader>();
  const [state, setState] = useState<OrderState>(snapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(
    snapshot.waits.length || rolledBack(snapshot) ? 'actions' : 'activity',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { revalidate } = useRevalidator();
  const orderId = snapshot.orderId!;
  const tabsId = useId();

  const agent = useAgent<OrderState>({
    agent: 'order-agent',
    name: orderId,
    onStateUpdate: (s) => setState(s),
  });

  // Payments, shipments and documents live in D1; refresh them as the run moves (throttled).
  const lastRefresh = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastRefresh.current < 1500) return;
    lastRefresh.current = now;
    revalidate();
  }, [state.updatedAt, revalidate]);

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
          ? 'That step is no longer waiting. It was decided elsewhere or escalated.'
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
  const assistant = useAssistant();
  const title = order.title || ORDER_MODEL_LABELS[order.model as OrderModel];
  usePageContext(
    () => ({ kind: 'order', id: orderId, label: `${title} ${orderRef(orderId)}` }),
    [orderId, title],
  );

  const tabs: { id: Tab; label: string; count?: number }[] = [
    {
      id: 'actions',
      label: rolledBack(state) && !state.waits.length ? 'Rollback' : 'Actions',
      count: state.waits.length || undefined,
    },
    { id: 'activity', label: 'Activity' },
    { id: 'details', label: 'Details' },
    { id: 'node', label: 'Node' },
  ];

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3rem)]">
      <header className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b px-4 py-3 sm:px-6">
        {/* A real basis, so the totals and actions wrap below the title on a phone instead of
            squeezing it to a column. */}
        <div className="min-w-0 flex-1 basis-72">
          <div className="caption">
            <Link to="/orders" className="hover:text-foreground hover:underline">
              Orders
            </Link>{' '}
            / {ORDER_MODEL_LABELS[order.model as OrderModel]}
          </div>
          <h1 className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold tracking-title text-xl leading-tight">
            <span className="min-w-0 truncate">
              {order.title || ORDER_MODEL_LABELS[order.model as OrderModel]}{' '}
              <span className="font-mono font-normal text-base text-muted-foreground">
                {orderRef(order.id)}
              </span>
            </span>
            <StatusBadge status={shownStatus(state)} />
          </h1>
          <p className="mt-1 text-muted-foreground text-xs">
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
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-semibold text-lg tabular">
              {money(order.total, order.currency)}
            </div>
            <div className="text-muted-foreground text-xs tabular">
              {plural(order.lines.length, 'line')} · tax {money(order.tax, order.currency)}
            </div>
          </div>
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
          {!terminal && canOperate ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy || cancelling}
              onClick={() => setCancelling(true)}
            >
              <CircleSlash /> Cancel order
            </Button>
          ) : null}
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
            {sentence(state.reason || finishedAt(state))}
            {state.rollback
              ? state.rollback.outcome === 'complete'
                ? ' Every completed step that can be undone was reversed.'
                : ' Some steps could not be reversed; see Rollback.'
              : ''}
          </p>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        <aside className="flex max-h-[75vh] min-h-0 flex-col border-b lg:col-start-2 lg:max-h-none lg:row-start-1 lg:border-b-0 lg:border-l">
          <div
            role="tablist"
            aria-label="Order panels"
            className="flex gap-1 overflow-x-auto border-b px-3 pt-2"
            onKeyDown={(e) => {
              const i = tabs.findIndex((t) => t.id === tab);
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
                aria-selected={tab === t.id}
                aria-controls={`${tabsId}-panel`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={cn(
                  '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 py-2 font-medium text-[13px] text-muted-foreground hover:text-foreground',
                  tab === t.id && 'border-foreground text-foreground',
                )}
              >
                {t.label}
                {t.count ? (
                  <span className="rounded-sm bg-wait/15 px-1.5 py-px text-[11px] text-wait tabular">
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
            aria-labelledby={`${tabsId}-${tab}`}
            className="min-h-0 flex-1 overflow-y-auto p-4"
          >
            {/* Stays mounted while hidden so an open undo window survives a tab switch. */}
            <div hidden={tab !== 'actions'}>
              <Compensation state={state} records={records} onSelect={select} />
              <Actions
                state={state}
                busy={busy}
                call={call}
                by={by}
                onSelect={select}
                sellers={records.sellers}
              />
            </div>
            {tab === 'activity' ? <Activity state={state} onSelect={select} /> : null}
            {tab === 'details' ? <Details state={state} records={records} /> : null}
            {tab === 'node' ? (
              node ? (
                <Inspector node={node} run={state.nodes[node.id]} />
              ) : (
                <Empty>Select a step on the graph to see its settings and last result.</Empty>
              )
            ) : null}
          </div>
        </aside>
        <div className="h-[60vh] min-h-[360px] p-3 sm:p-4 lg:col-start-1 lg:row-start-1 lg:h-auto">
          <FlowCanvas
            graph={flow}
            runs={state.nodes}
            edgeStates={state.edges}
            issues={issues}
            selectedId={selected}
            onSelect={(id) => {
              setSelected(id);
              if (id) setTab('node');
            }}
          />
        </div>
      </div>
    </div>
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
      <div className="min-w-0 flex-1 basis-72">
        <p className="font-medium text-sm">Cancel this order?</p>
        <p className="text-muted-foreground text-xs">
          The flow stops, and completed steps that can be undone (reservations, card authorizations,
          shipments) are reversed.
        </p>
        <label htmlFor={id} className="caption mt-2 block">
          Reason, kept in the order history
        </label>
        <Input
          id={id}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 h-8 max-w-md"
          autoFocus
        />
      </div>
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

  return (
    <section aria-labelledby="rollback-title" className="mb-6">
      <h2 id="rollback-title" className="section-title flex items-center gap-2">
        <Undo2 className="size-4 text-undo" aria-hidden="true" />
        {failed ? 'Rollback incomplete' : state.rollback ? 'Rolled back' : 'Rolling back'}
      </h2>
      {!cause && state.reason ? <p className="mt-1 text-sm">{sentence(state.reason)}</p> : null}
      {cause ? (
        <p className="mt-1 text-sm">
          Stopped at{' '}
          <button
            type="button"
            className="font-medium text-link hover:underline"
            onClick={() => onSelect(cause[0])}
          >
            {label(cause[0])}
          </button>
          {cause[1].error ? (
            <span className="text-muted-foreground">: {cause[1].error}</span>
          ) : null}
        </p>
      ) : null}
      <table className="mt-3 w-full text-sm">
        <caption className="sr-only">Steps reversed, in the order they were undone</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="caption pb-1.5 font-medium">
              Step
            </th>
            <th scope="col" className="caption pb-1.5 font-medium">
              Reversed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {reversed.length ? (
            reversed.map(([id, r]) => (
              <tr key={id} className="align-top">
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => onSelect(id)}
                  >
                    {label(id)}
                  </button>
                </td>
                <td className="py-2 text-muted-foreground">
                  {noop(r.summary) ? 'Nothing to undo yet' : (r.summary ?? 'Reversed')}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} className="py-2 text-muted-foreground">
                Nothing had been done that needed undoing.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="double-rule border-t">
            <td className="pt-2 pb-1.5 font-medium">
              {undone ? `${plural(undone, 'step')} reversed` : 'Nothing needed undoing'}
            </td>
            <td className="pt-2 pb-1.5 text-right font-medium tabular">
              {voided ? `${money(voided, currency)} released to the card` : ''}
            </td>
          </tr>
        </tfoot>
      </table>
      {failed ? (
        <p className="mt-3 text-bad text-sm">
          {state.rollback?.error ? `${state.rollback.error}. ` : ''}Check Payments and Shipments
          under Details and settle what is left by hand.
        </p>
      ) : null}
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
    <div className="mt-5 border-t pt-4">
      <h3 className="section-title">Next</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
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
      <p className="mt-2 text-muted-foreground text-xs">
        The new order runs on the flow’s current version; this one stays as it is, for the record.
        To see what blocked it,{' '}
        <Link to="/back-office" className="text-link hover:underline">
          check stock and credit
        </Link>
        .
      </p>
      {restart.data?.error ? (
        <p className="mt-2 text-bad text-sm" role="alert">
          {restart.data.error}
        </p>
      ) : null}
    </div>
  );
}

function Actions({
  state,
  busy,
  call,
  by,
  onSelect,
  sellers,
}: {
  state: OrderState;
  busy: string | null;
  call: Call;
  by: string;
  onSelect: (id: string) => void;
  sellers: Records['sellers'];
}) {
  const canApprove = useCan('approver');
  const canOperate = useCan('operator');
  const formatTime = useDateTime();
  if (!state.waits.length) {
    if (rolledBack(state)) return null;
    return (
      <Empty>
        {TERMINAL_ORDER_STATUSES.includes(state.status)
          ? 'This order has finished. Its history is under Activity.'
          : 'Nothing is waiting on a person or an outside event. The flow is running on its own.'}
      </Empty>
    );
  }
  const label = (id: string) => state.flow?.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="space-y-3">
      {state.waits.map((w) => (
        <div key={w.eventType} className="rounded-md border border-wait/35 bg-wait/[0.06] p-3">
          <div className="flex items-center gap-2 text-wait text-xs">
            <StatusDot status="waiting" />
            {w.kind === 'approval'
              ? `Approval for ${humanize(w.assignee) || 'anyone'}`
              : 'Waiting for an outside event'}
            <span className="ml-auto text-muted-foreground">
              since <Ago ms={w.since} />
            </span>
          </div>
          <button
            type="button"
            className="mt-1.5 text-left font-medium text-sm hover:underline"
            onClick={() => onSelect(w.nodeId)}
          >
            {label(w.nodeId)}
          </button>
          {w.kind === 'approval' ? (
            <>
              <DecisionContext ctx={approvalContext(state, w.nodeId)} className="mt-1" />
              <div className="mt-3">
                {canApprove ? (
                  <DecisionControls
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
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-muted-foreground text-xs">
                Resumes when <span className="font-mono text-foreground">{w.event}</span> arrives
                {w.deadline ? `, or times out ${formatTime(w.deadline)}` : ''}. Systems send it to{' '}
                <span className="break-all font-mono">
                  POST /api/v1/orders/{state.orderId}/events
                </span>
                .
              </p>
              {canOperate && w.event === 'seller.responded' ? (
                <div className="mt-3 space-y-1.5">
                  {sellers
                    .filter((s) => s.status === 'pending')
                    .map((s) => (
                      <div key={s.sellerId} className="flex flex-wrap items-center gap-1.5">
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
                      </div>
                    ))}
                </div>
              ) : canOperate ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  disabled={!!busy}
                  onClick={() =>
                    call('event', 'deliver', [
                      w.event,
                      { source: 'dashboard', amount: state.order?.total },
                    ])
                  }
                >
                  <Zap /> Simulate {w.event}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  approval: 'text-wait',
  event: 'text-link',
  ai: 'text-ai',
  rollback: 'text-undo',
  order: 'text-foreground',
  node: 'text-muted-foreground',
};

function Activity({ state, onSelect }: { state: OrderState; onSelect: (id: string) => void }) {
  const formatTime = useDateTime();
  const items = [...state.timeline].reverse();
  const start = state.timeline[0]?.at ?? 0;
  const label = (id: string) => state.flow?.nodes.find((n) => n.id === id)?.label ?? id;
  if (!items.length) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <ol className="space-y-2.5">
      {items.map((t, i) => (
        <li key={`${t.at}-${i}`} className="flex gap-3 text-sm">
          <time
            dateTime={new Date(t.at).toISOString()}
            title={formatTime(t.at)}
            className="w-14 shrink-0 pt-px text-right text-muted-foreground text-xs tabular"
          >
            {offset(t.at, start)}
          </time>
          <span className={cn('min-w-0 flex-1', KIND_TONE[t.kind])}>
            {t.nodeId ? (
              <button
                type="button"
                className="mr-1.5 font-medium text-foreground hover:underline"
                onClick={() => onSelect(t.nodeId!)}
              >
                {label(t.nodeId)}
              </button>
            ) : null}
            {plainLog(t.nodeId ? t.message.replace(`${label(t.nodeId)}: `, '') : t.message)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Details({ state, records }: { state: OrderState; records: Records }) {
  const o = state.order!;
  return (
    <div className="space-y-6 text-sm">
      <section>
        <h3 className="section-title mb-2">Lines</h3>
        {o.lines.length ? (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="caption pb-1.5 font-medium">
                  Item
                </th>
                <th scope="col" className="caption pb-1.5 text-right font-medium">
                  Qty
                </th>
                <th scope="col" className="caption pb-1.5 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {o.lines.map((l) => (
                <tr key={l.sku}>
                  <td className="py-1.5 pr-2">
                    {l.name ?? l.sku}
                    {l.name ? (
                      <span className="ml-1.5 font-mono text-muted-foreground text-xs">
                        {l.sku}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 text-right tabular">{l.qty}</td>
                  <td className="py-1.5 text-right tabular">
                    {l.unitPrice !== undefined ? money(l.unitPrice * l.qty, o.currency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t">
                <td colSpan={2} className="pt-1.5 text-muted-foreground">
                  Tax
                </td>
                <td className="pt-1.5 text-right tabular">{money(o.tax, o.currency)}</td>
              </tr>
              <tr className="double-rule">
                <td colSpan={2} className="pt-1 pb-1 font-medium">
                  Total
                </td>
                <td className="pt-1 pb-1 text-right font-semibold tabular">
                  {money(o.total, o.currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <p className="text-muted-foreground">No lines yet.</p>
        )}
      </section>
      {records.documents.length ? (
        <section>
          <h3 className="section-title mb-2">Documents</h3>
          <ul className="space-y-1">
            {records.documents.map((d) => (
              <li key={d.id}>
                <a
                  href={`/docs/${d.r2Key}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-link hover:underline"
                >
                  <FileText className="size-3.5" aria-hidden="true" /> {humanize(d.kind)} ·{' '}
                  {d.r2Key.split('/').pop()}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Ledger
        title="Payments"
        rows={records.payments.map((p) => [
          humanize(p.kind),
          humanize(p.status),
          money(p.amount, o.currency),
        ])}
      />
      <Ledger
        title="Sellers"
        rows={records.sellers.map((s) => [
          s.name,
          s.reason ? `${humanize(s.status)}: ${s.reason}` : humanize(s.status),
          money(s.subtotal, o.currency),
        ])}
      />
      <Ledger
        title="Seller payouts"
        rows={records.payouts.map((p) => [
          `${p.name ?? p.sellerId} (${money(p.commission, o.currency)} commission)`,
          humanize(p.status),
          money(p.net, o.currency),
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
      <details className="group">
        <summary className="caption flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
          <ChevronRight
            className="size-3.5 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          Flow variables (for debugging)
        </summary>
        <pre className="mt-2 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
          {JSON.stringify(state.vars, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Ledger({ title, rows }: { title: string; rows: [string, string, string][] }) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="section-title mb-2">{title}</h3>
      <table className="w-full">
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={`${title}-${i}`}>
              <td className="py-1.5 pr-2">{r[0]}</td>
              <td className="py-1.5 pr-2 text-muted-foreground">{r[1]}</td>
              <td className="py-1.5 text-right tabular">{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
