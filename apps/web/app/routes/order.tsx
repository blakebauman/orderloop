/**
 * The live order page. The loader renders a snapshot; in the browser, `useAgent` connects to the
 * order's OrderAgent (proxied by workers/app.ts) and every state change it broadcasts re-renders
 * the graph, waits, timeline and chat. Actions are agent RPC calls over the same socket.
 */

import {
  ORDER_TYPE_LABELS,
  type OrderState,
  type OrderType,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { useAgent } from 'agents/react';
import { Bot, Check, CircleSlash, FileText, Send, Undo2, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { data, Link, useLoaderData, useRevalidator } from 'react-router';
import { FlowCanvas } from '~/components/flow-canvas';
import { Inspector } from '~/components/inspector';
import { Empty } from '~/components/page';
import { StatusBadge, StatusDot } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ago, money } from '~/lib/format';
import { orderRecords } from '~/lib/orders.server';
import type { Route } from './+types/order';

export const meta = ({ params }: Route.MetaArgs) => [{ title: `${params.orderId} · Order Loop` }];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const snapshot = await engine().snapshot(params.orderId);
  if (!snapshot) throw data('Order not found', { status: 404 });
  return { snapshot, records: await orderRecords(params.orderId) };
}

type Tab = 'actions' | 'activity' | 'details' | 'chat' | 'node';

export default function OrderPage() {
  const { snapshot, records } = useLoaderData<typeof loader>();
  const [state, setState] = useState<OrderState>(snapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(snapshot.waits.length ? 'actions' : 'activity');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { revalidate } = useRevalidator();
  const orderId = snapshot.orderId!;

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

  const call = async (label: string, method: string, args: unknown[]) => {
    setBusy(label);
    setError(null);
    try {
      return await agent.call(method, args);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-3">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs">
            <Link to="/orders" className="hover:underline">
              Orders
            </Link>{' '}
            / {ORDER_TYPE_LABELS[order.type as OrderType]}
          </div>
          <h1 className="flex items-center gap-2 truncate font-semibold text-lg tracking-tight">
            {order.title || order.id}
            <StatusBadge status={state.status} />
          </h1>
          <div className="font-mono text-[11px] text-muted-foreground">
            {order.id} · {flow.name} v{flow.version}
            {state.generation > 1 ? ` · run ${state.generation}` : ''}
            {order.customerId ? ` · ${order.customerId}` : ''}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="text-right">
            <div className="font-semibold text-lg tabular">
              {money(order.total, order.currency)}
            </div>
            <div className="text-muted-foreground text-xs">
              {order.lines.length} lines · tax {money(order.tax, order.currency)}
            </div>
          </div>
          {!terminal ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => {
                const reason = window.prompt('Cancel this order? Reason:', 'Customer cancelled');
                if (reason) void call('cancel', 'cancel', [reason]);
              }}
            >
              <CircleSlash /> Cancel
            </Button>
          ) : null}
        </div>
      </header>

      {state.reason && terminal ? (
        <div
          className={cn(
            'border-b px-6 py-2 text-sm',
            state.status === 'completed' ? 'text-ok' : 'text-wait',
          )}
        >
          {state.status === 'rolled_back' ? <Undo2 className="mr-1.5 inline size-3.5" /> : null}
          {state.reason}
          {state.rollback ? ` — rollback ${state.rollback.outcome}` : ''}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-h-[420px] p-4">
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

        <aside className="flex min-h-0 flex-col border-l">
          <nav className="flex gap-1 border-b px-3 pt-2">
            {(['actions', 'activity', 'details', 'chat', 'node'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px rounded-t-md border-b-2 border-transparent px-2.5 py-1.5 font-medium text-xs capitalize text-muted-foreground hover:text-foreground',
                  tab === t && 'border-primary text-foreground',
                )}
              >
                {t}
                {t === 'actions' && state.waits.length ? (
                  <span className="ml-1 rounded-full bg-wait/20 px-1.5 text-wait">
                    {state.waits.length}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          {error ? (
            <div className="border-b bg-bad/10 px-4 py-2 text-bad text-xs">{error}</div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'actions' ? <Actions state={state} busy={busy} call={call} /> : null}
            {tab === 'activity' ? (
              <Activity
                state={state}
                onSelect={(id) => {
                  setSelected(id);
                  setTab('node');
                }}
              />
            ) : null}
            {tab === 'details' ? <Details state={state} records={records} /> : null}
            {tab === 'chat' ? <Chat state={state} busy={busy} call={call} /> : null}
            {tab === 'node' ? (
              node ? (
                <Inspector node={node} run={state.nodes[node.id]} />
              ) : (
                <Empty>Select a node on the graph.</Empty>
              )
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

type Call = (label: string, method: string, args: unknown[]) => Promise<unknown>;

function Actions({ state, busy, call }: { state: OrderState; busy: string | null; call: Call }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!state.waits.length) {
    return (
      <Empty>
        {TERMINAL_ORDER_STATUSES.includes(state.status)
          ? 'This order has finished.'
          : 'Nothing is waiting on a person or an event right now.'}
      </Empty>
    );
  }
  return (
    <div className="space-y-3">
      {state.waits.map((w) => (
        <div key={w.eventType} className="rounded-md border border-wait/30 bg-wait/5 p-3">
          <div className="flex items-center gap-2 text-[11px] text-wait uppercase tracking-wide">
            <StatusDot status="waiting" />{' '}
            {w.kind === 'approval' ? `Approval · ${w.assignee}` : 'Waiting for event'}
          </div>
          <div className="mt-1 font-medium text-sm">{w.title}</div>
          <div className="mt-0.5 text-muted-foreground text-xs">
            since {ago(w.since)}
            {w.deadline
              ? ` · ${w.kind === 'approval' ? 'escalates' : 'times out'} ${new Date(w.deadline).toLocaleString()}`
              : ''}
          </div>
          {w.kind === 'approval' ? (
            <>
              <Input
                placeholder="Note (optional)"
                className="mt-3 h-8 text-xs"
                value={notes[w.nodeId] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [w.nodeId]: e.target.value }))}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    call('approve', 'decide', [w.nodeId, 'approved', 'operator', notes[w.nodeId]])
                  }
                >
                  <Check /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() =>
                    call('reject', 'decide', [w.nodeId, 'rejected', 'operator', notes[w.nodeId]])
                  }
                >
                  <X /> Reject
                </Button>
              </div>
            </>
          ) : (
            <Button
              size="sm"
              className="mt-3"
              disabled={!!busy}
              onClick={() =>
                call('event', 'deliver', [
                  w.event,
                  { source: 'dashboard', amount: state.order?.total },
                ])
              }
            >
              <Zap /> Simulate <span className="font-mono">{w.event}</span>
            </Button>
          )}
        </div>
      ))}
      <p className="text-muted-foreground text-xs">
        External systems resume these with{' '}
        <span className="font-mono">POST /api/v1/orders/{state.orderId}/events</span>.
      </p>
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  approval: 'text-wait',
  event: 'text-primary',
  ai: 'text-ai',
  rollback: 'text-undo',
  order: 'text-foreground',
  node: 'text-muted-foreground',
};

function Activity({ state, onSelect }: { state: OrderState; onSelect: (id: string) => void }) {
  const items = [...state.timeline].reverse();
  return (
    <ol className="space-y-2.5">
      {items.map((t, i) => (
        <li key={`${t.at}-${i}`} className="flex gap-3 text-xs">
          <span className="w-16 shrink-0 text-right text-muted-foreground tabular">
            {new Date(t.at).toLocaleTimeString()}
          </span>
          <span className={cn('min-w-0 flex-1', KIND_TONE[t.kind])}>
            {t.nodeId ? (
              <button
                type="button"
                className="mr-1 font-mono text-[11px] text-primary/80 hover:underline"
                onClick={() => onSelect(t.nodeId!)}
              >
                {t.nodeId}
              </button>
            ) : null}
            {t.message}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Details({
  state,
  records,
}: {
  state: OrderState;
  records: Awaited<ReturnType<typeof orderRecords>>;
}) {
  const o = state.order!;
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Lines
        </h3>
        {o.lines.length ? (
          <table className="w-full text-xs">
            <tbody className="divide-y">
              {o.lines.map((l) => (
                <tr key={l.sku}>
                  <td className="py-1.5 font-mono">{l.sku}</td>
                  <td className="py-1.5 text-muted-foreground">{l.name}</td>
                  <td className="py-1.5 text-right tabular">{l.qty}</td>
                  <td className="py-1.5 text-right tabular">
                    {l.unitPrice !== undefined ? money(l.unitPrice * l.qty, o.currency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground text-xs">No lines yet.</p>
        )}
      </section>
      {records.documents.length ? (
        <section>
          <h3 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Documents (R2)
          </h3>
          <ul className="space-y-1">
            {records.documents.map((d) => (
              <li key={d.id}>
                <a
                  href={`/docs/${d.r2Key}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-primary text-xs hover:underline"
                >
                  <FileText className="size-3.5" /> {d.kind} · {d.r2Key.split('/').pop()}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Records
        title="Payments"
        rows={records.payments.map((p) => `${p.kind} · ${money(p.amount)} · ${p.status}`)}
      />
      <Records
        title="Shipments"
        rows={records.shipments.map(
          (s) => `${s.carrier.toUpperCase()} ${s.tracking} · ${s.status}`,
        )}
      />
      <Records
        title="Messages sent"
        rows={records.messages.map((m) => `→ ${m.recipient}: ${m.subject}`)}
      />
      <section>
        <h3 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Variables
        </h3>
        <pre className="overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px]">
          {JSON.stringify(state.vars, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function Records({ title, rows }: { title: string; rows: string[] }) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <ul className="space-y-1 text-xs">
        {rows.map((r, i) => (
          <li key={`${title}-${i}`} className="text-muted-foreground">
            {r}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Chat({ state, busy, call }: { state: OrderState; busy: string | null; call: Call }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages arrive
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [state.chat.length]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await call('chat', 'chat', [t]);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3">
        {state.chat.length === 0 ? (
          <Empty>
            Ask the order’s agent anything: “why is this waiting?”, “approve it with a note”, “mark
            payment received”.
          </Empty>
        ) : null}
        {state.chat.map((m) => (
          <div key={m.id} className={cn('flex gap-2', m.role === 'user' && 'justify-end')}>
            {m.role === 'assistant' ? <Bot className="mt-1 size-4 shrink-0 text-ai" /> : null}
            <div
              className={cn(
                'max-w-[85%] rounded-md px-3 py-2 text-sm',
                m.role === 'user' ? 'bg-primary/15' : 'bg-muted/50',
              )}
            >
              <div className="whitespace-pre-wrap">{m.content}</div>
              {m.tools?.length ? (
                <div className="mt-1.5 space-y-0.5">
                  {m.tools.map((t, i) => (
                    <div
                      key={`${m.id}-${i}`}
                      className="font-mono text-[10.5px] text-muted-foreground"
                    >
                      ⚙ {t.name}({JSON.stringify(t.args)})
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {busy === 'chat' ? <div className="text-muted-foreground text-xs">Thinking…</div> : null}
        <div ref={end} />
      </div>
      <form
        className="sticky bottom-0 mt-3 flex gap-2 bg-background pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message the order agent"
          className="h-9"
        />
        <Button type="submit" size="icon" disabled={!!busy || !text.trim()} aria-label="Send">
          <Send />
        </Button>
      </form>
    </div>
  );
}
