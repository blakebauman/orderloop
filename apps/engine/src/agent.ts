/**
 * OrderAgent: one Agents SDK Durable Object per order. It holds the live run state that syncs to
 * every browser on the order page, records what the Workflow reports, owns the order's waits
 * (approvals and external events) and their delivery, cancels with compensation, and answers the
 * ops chat with tools over the same state.
 */

import {
  type ChatMessage,
  type ChatProposal,
  type EdgeState,
  EMPTY_ORDER_STATE,
  type FlowVersion,
  type NodeRun,
  newId,
  type Order,
  type OrderState,
  type OrderStatus,
  type OutboundEvent,
  type PendingWait,
  type PlanNode,
  TERMINAL_ORDER_STATUSES,
  type TimelineEntry,
} from '@orderloop/core';
import { approvals, createDb, nodeRuns, orders } from '@orderloop/db';
import { Agent, type Connection, callable } from 'agents';
import { and, eq } from 'drizzle-orm';
import { runJson } from './ai';
import { compensateOrder } from './connectors';
import { emit, orderSummary } from './outbox';

export type Report = {
  /** Plan snapshots are sequenced per generation; stale ones are dropped. */
  seq?: number;
  generation?: number;
  status?: OrderStatus;
  reason?: string;
  plan?: { nodes: Record<string, PlanNode>; edges: Record<string, EdgeState> };
  order?: Order;
  vars?: Record<string, unknown>;
  node?: { id: string } & Partial<NodeRun>;
  log?: TimelineEntry;
};

type State = OrderState & { seq: number };

const TIMELINE_CAP = 400;
// Matches the Workflow's emit step: 5 retries with exponential backoff from 10 seconds.
const WEBHOOK_RETRIES = 5;

export class OrderAgent extends Agent<Env, State> {
  override initialState: State = { ...EMPTY_ORDER_STATE, seq: 0 };

  /** Browsers may read and call methods, never write state directly. */
  override validateStateChange(_next: State, source: Connection | 'server') {
    if (source !== 'server') throw new Error('Order state is read-only');
  }

  private patch(p: Partial<State>) {
    this.setState({ ...this.state, ...p, updatedAt: Date.now() });
  }

  private log(entry: Omit<TimelineEntry, 'at'> & { at?: number }, base = this.state.timeline) {
    const e: TimelineEntry = { at: Date.now(), ...entry };
    const timeline = e.key ? [...base.filter((t) => t.key !== e.key), e] : [...base, e];
    return timeline.slice(-TIMELINE_CAP);
  }

  private db() {
    return createDb(this.env.DB);
  }

  private async syncIndex() {
    const s = this.state;
    if (!s.orderId || !s.order) return;
    await this.db()
      .update(orders)
      .set({
        status: s.status,
        total: s.order.total,
        customerId: s.order.customerId ?? null,
        title: s.order.title ?? '',
        instanceId: s.instanceId,
        generation: s.generation,
        waitingOn: s.waits.map((w) => w.title).join(' · ') || null,
        updatedAt: Date.now(),
      })
      .where(eq(orders.id, s.orderId));
  }

  // ── Called by EngineApi and the Workflow ───────────────────────────────────

  async snapshot(): Promise<OrderState> {
    return this.state;
  }

  async init(order: Order, flow: FlowVersion, instanceId: string) {
    // A replayed start may call this again; never reset a run that has begun.
    if (this.state.instanceId === instanceId) return;
    this.setState({
      ...EMPTY_ORDER_STATE,
      seq: 0,
      orderId: order.id,
      order,
      flow,
      instanceId,
      generation: 1,
      status: 'queued',
      nodes: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: 'pending', runs: 0 }])),
      edges: Object.fromEntries(flow.edges.map((e) => [e.id, 'pending'])),
      timeline: [
        {
          at: Date.now(),
          kind: 'order',
          message: `Order created on ${flow.name} v${flow.version}`,
        },
      ],
      updatedAt: Date.now(),
    });
  }

  async report(r: Report) {
    const s = this.state;
    let next: State = { ...s };
    const gen = r.generation ?? s.generation;
    const sequenced = r.seq !== undefined;
    const fresh = !sequenced || gen > s.generation || (gen === s.generation && r.seq! > s.seq);

    if (sequenced && fresh) {
      next.seq = r.seq!;
      if (r.plan) {
        const nodes: Record<string, NodeRun> = { ...next.nodes };
        for (const [id, pn] of Object.entries(r.plan.nodes)) {
          const cur = nodes[id] ?? { status: 'pending', runs: 0 };
          // Rollback and failure come from their own reports; a later plan never clears them.
          const keep = cur.status === 'rolled_back' || cur.status === 'failed';
          nodes[id] = {
            ...cur,
            status: keep ? cur.status : pn.status,
            runs: pn.runs,
            branches: pn.branches,
          };
        }
        next.nodes = nodes;
        next.edges = r.plan.edges;
      }
      if (r.order) next.order = r.order;
      if (r.vars) next.vars = r.vars;
    }
    if (r.status && (fresh || !sequenced) && !TERMINAL_ORDER_STATUSES.includes(s.status)) {
      next.status = r.status;
      if (r.reason !== undefined) next.reason = r.reason;
      if (r.status !== s.status) {
        next.timeline = this.log(
          {
            kind: 'order',
            message: `Order ${r.status}${r.reason ? `: ${r.reason}` : ''}`,
            key: `status:${gen}:${r.status}`,
          },
          next.timeline,
        );
      }
    }
    let finished: { id: string; run: NodeRun } | null = null;
    if (r.node) {
      const { id, ...detail } = r.node;
      const cur = next.nodes[id] ?? { status: 'pending', runs: 0 };
      const running = cur.startedAt !== undefined && cur.endedAt === undefined;
      if (detail.startedAt !== undefined) {
        // A retried attempt keeps the run's first start; a new run starts afresh.
        if (running) detail.startedAt = cur.startedAt;
        else detail.endedAt = undefined;
      }
      const merged = { ...cur, ...detail };
      next.nodes = { ...next.nodes, [id]: merged };
      // Only the first end of a running node counts, so replayed reports never add a row.
      if (running && detail.endedAt !== undefined && detail.endedAt >= cur.startedAt!)
        finished = { id, run: merged };
    }
    if (r.log) next.timeline = this.log(r.log, next.timeline);
    next = { ...next, updatedAt: Date.now() };
    this.setState(next);

    if (finished) await this.recordRun(finished.id, finished.run);

    const statusChanged = next.status !== s.status;
    if (statusChanged || r.order) await this.syncIndex();
    // A failed order rolls back inside the Workflow; poll it until it settles to record the outcome.
    if (statusChanged && next.status === 'failed')
      await this.schedule(5, 'checkInstance', { attempt: 0 });
  }

  /** Writes one finished node run for the dashboard's timing; a repeat is a no-op. */
  private async recordRun(nodeId: string, run: NodeRun) {
    const s = this.state;
    const type = s.flow?.nodes.find((n) => n.id === nodeId)?.type;
    if (!s.orderId || !s.order || !type || run.startedAt === undefined || run.endedAt === undefined)
      return;
    await this.db()
      .insert(nodeRuns)
      .values({
        orderId: s.orderId,
        generation: s.generation,
        nodeId,
        run: Math.max(1, run.runs),
        nodeType: type,
        orderType: s.order.type,
        status: run.status === 'failed' ? 'failed' : 'succeeded',
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.endedAt - run.startedAt,
      })
      .onConflictDoNothing();
  }

  async openWait(w: PendingWait) {
    if (this.state.waits.some((x) => x.eventType === w.eventType)) return;
    if (w.kind === 'approval' && this.state.orderId) {
      await this.db()
        .insert(approvals)
        .values({
          id: newId('apr'),
          orderId: this.state.orderId,
          nodeId: w.nodeId,
          eventType: w.eventType,
          title: w.title,
          assignee: w.assignee ?? '',
          amount: w.amount ?? null,
          status: 'pending',
          requestedAt: Date.now(),
        })
        .onConflictDoNothing();
    }
    const node = this.state.nodes[w.nodeId] ?? { status: 'pending' as const, runs: 0 };
    this.patch({
      // A wait's run starts when it opens; this runs in the Workflow's memoized `:open` step.
      nodes: {
        ...this.state.nodes,
        [w.nodeId]: { ...node, startedAt: w.since, endedAt: undefined },
      },
      waits: [...this.state.waits, w],
      timeline: this.log({
        nodeId: w.nodeId,
        kind: w.kind === 'approval' ? 'approval' : 'event',
        message:
          w.kind === 'approval'
            ? `Awaiting approval: ${w.title} (${w.assignee})`
            : `Waiting for ${w.event}`,
        key: `open:${w.eventType}`,
      }),
    });
    await this.syncIndex();
  }

  async closeWait(eventType: string, outcome: string, payload: Record<string, unknown>) {
    const w = this.state.waits.find((x) => x.eventType === eventType);
    if (w?.kind === 'approval' && this.state.orderId) {
      await this.db()
        .update(approvals)
        .set({
          status: outcome,
          decidedAt: Date.now(),
          decidedBy:
            typeof payload.by === 'string'
              ? payload.by
              : outcome === 'escalated'
                ? 'timeout'
                : null,
          note: typeof payload.note === 'string' ? payload.note : null,
        })
        .where(and(eq(approvals.orderId, this.state.orderId), eq(approvals.eventType, eventType)));
    }
    this.patch({
      waits: this.state.waits.filter((x) => x.eventType !== eventType),
      timeline: this.log({
        nodeId: w?.nodeId,
        kind: w?.kind === 'approval' ? 'approval' : 'event',
        message: w
          ? `${w.title}: ${outcome}${payload.by ? ` by ${String(payload.by)}` : ''}${payload.note ? ` — “${String(payload.note)}”` : ''}`
          : outcome,
        key: `close:${eventType}`,
      }),
    });
    await this.syncIndex();
  }

  async continuedAs(instanceId: string, generation: number) {
    if (generation <= this.state.generation) return;
    this.patch({
      instanceId,
      generation,
      seq: 0,
      timeline: this.log({
        kind: 'order',
        message: `Continued as run ${generation}`,
        key: `gen:${generation}`,
      }),
    });
    await this.syncIndex();
  }

  async checkInstance(payload: { attempt: number }) {
    if (!this.state.instanceId) return;
    // `rollback` is newer than the installed workers-types.
    const st = (await (
      await this.env.ORDER_LOOP.get(this.state.instanceId)
    ).status()) as InstanceStatus & {
      rollback?: { outcome: 'complete' | 'failed'; error: { message: string } | null } | null;
    };
    const settled = ['errored', 'terminated', 'complete'].includes(st.status);
    if (!settled) {
      if (payload.attempt < 60)
        await this.schedule(10, 'checkInstance', { attempt: payload.attempt + 1 });
      return;
    }
    // Older runtimes (and local dev) omit `rollback`; fall back to the rollback reports we received.
    const rolledBack = Object.values(this.state.nodes).some((n) => n.status === 'rolled_back');
    const rb =
      st.rollback ??
      (st.status === 'errored' && rolledBack
        ? { outcome: 'complete' as const, error: null }
        : null);
    if (!rb) return;
    this.patch({
      rollback: { outcome: rb.outcome, error: rb.error?.message ?? null },
      status: rb.outcome === 'complete' ? 'rolled_back' : 'failed',
      timeline: this.log({
        kind: 'rollback',
        message:
          rb.outcome === 'complete' ? 'Rollback complete' : `Rollback failed: ${rb.error?.message}`,
        key: 'rollback:done',
      }),
    });
    await this.syncIndex();
  }

  // ── Callable from the order page (the web app authorizes the connection) ──

  /** Approve or reject the approval a node is waiting on. */
  @callable()
  async decide(nodeId: string, decision: 'approved' | 'rejected', by = 'operator', note?: string) {
    const w = this.state.waits.find((x) => x.kind === 'approval' && x.nodeId === nodeId);
    if (!w || !this.state.instanceId) throw new Error('That node is not waiting for an approval');
    const instance = await this.env.ORDER_LOOP.get(this.state.instanceId);
    await instance.sendEvent({ type: w.eventType, payload: { decision, by, note: note ?? null } });
    return { ok: true };
  }

  /** Deliver a business event (e.g. "payment.received") to whichever node waits for it. */
  @callable()
  async deliver(event: string, payload: Record<string, unknown> = {}) {
    const w = this.state.waits.find((x) => x.kind === 'event' && x.event === event);
    if (!w || !this.state.instanceId) return { delivered: false };
    const instance = await this.env.ORDER_LOOP.get(this.state.instanceId);
    await instance.sendEvent({ type: w.eventType, payload: { ...payload, event, at: Date.now() } });
    return { delivered: true, nodeId: w.nodeId };
  }

  @callable()
  async cancel(reason = 'Cancelled by operator') {
    if (TERMINAL_ORDER_STATUSES.includes(this.state.status)) return { ok: false };
    if (this.state.instanceId) {
      try {
        await (await this.env.ORDER_LOOP.get(this.state.instanceId)).terminate();
      } catch (err) {
        console.warn('terminate', err);
      }
    }
    const undone = this.state.orderId ? await compensateOrder(this.env, this.state.orderId) : null;
    if (this.state.orderId) {
      await this.db()
        .update(approvals)
        .set({ status: 'cancelled', decidedAt: Date.now() })
        .where(and(eq(approvals.orderId, this.state.orderId), eq(approvals.status, 'pending')));
    }
    this.patch({
      status: 'cancelled',
      reason,
      waits: [],
      timeline: this.log({
        kind: 'order',
        message: `Cancelled: ${reason}${undone ? ` (released ${undone.released}, voided ${undone.voided}, cancelled ${undone.cancelled} shipments)` : ''}`,
      }),
    });
    await this.syncIndex();
    // Cancelling terminates the Workflow, so no End node announces it; the agent does.
    await this.schedule(0, 'emitWebhook', {
      key: 'cancel',
      event: 'order.cancelled',
      data: {
        order: this.state.order ? orderSummary(this.state.order) : null,
        outcome: 'cancelled',
        reason,
      },
      attempt: 0,
    });
    return { ok: true };
  }

  /**
   * Delivers an outbound webhook from the agent, for endings the Workflow doesn't see. Retries on
   * the agent's own schedule with the same backoff as `emitStep`, then leaves the row `failed`.
   */
  async emitWebhook(p: {
    key: string;
    event: OutboundEvent;
    data: Record<string, unknown>;
    attempt: number;
  }) {
    if (!this.state.orderId) return;
    let pending = 1;
    try {
      ({ pending } = await emit(this.env, p.key, this.state.orderId, p.event, p.data));
    } catch (err) {
      console.warn('webhook emit', p.event, err);
    }
    if (pending && p.attempt < WEBHOOK_RETRIES)
      await this.schedule(10 * 2 ** p.attempt, 'emitWebhook', { ...p, attempt: p.attempt + 1 });
  }

  /** Ops chat: the model answers from the order state and may act through tools. */
  @callable()
  async chat(text: string) {
    const user: ChatMessage = {
      id: newId('msg'),
      role: 'user',
      content: text.slice(0, 4000),
      at: Date.now(),
    };
    this.patch({ chat: [...this.state.chat, user] });
    const tools: ChatMessage['tools'] = [];
    let proposal: ChatProposal | undefined;
    let reply = '';
    for (let turn = 0; turn < 4 && !reply; turn++) {
      const { value } = await runJson<{
        action: 'reply' | 'tool';
        tool?: string;
        args?: Record<string, unknown>;
        reply?: string;
      }>(
        this.env,
        [
          {
            role: 'system',
            content: `You are the operations agent for order ${this.state.orderId}. Answer briefly from the order state. Tools: get_state {}, approve {nodeId, note?}, reject {nodeId, note?}, deliver_event {event}, cancel {reason}. approve, reject and cancel only prepare the action; a person confirms it on the order page. Only use them when the user clearly asks. Reply with {"action":"tool",...} to call a tool, or {"action":"reply","reply":"..."} to answer.`,
          },
          {
            role: 'user',
            content: JSON.stringify({
              summary: this.brief(),
              tools_called: tools,
              history: this.state.chat.slice(-8).map((m) => ({ role: m.role, content: m.content })),
            }),
          },
        ],
        {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['reply', 'tool'] },
            tool: {
              type: 'string',
              enum: ['get_state', 'approve', 'reject', 'deliver_event', 'cancel'],
            },
            args: { type: 'object' },
            reply: { type: 'string' },
          },
          required: ['action'],
        },
        () => this.chatHeuristic(text, tools.length > 0),
      );
      if (value.action === 'tool' && value.tool) {
        const result = await this.runTool(value.tool, value.args ?? {}).catch((e: Error) => ({
          error: e.message,
        }));
        tools.push({ name: value.tool, args: value.args ?? {}, result });
        if (result && typeof result === 'object' && 'proposal' in result) {
          proposal = result.proposal as ChatProposal;
          reply = proposalText(proposal, this.state);
        }
      } else {
        reply = value.reply || 'Done.';
      }
    }
    const answer: ChatMessage = {
      id: newId('msg'),
      role: 'assistant',
      content: reply || 'I took the requested action.',
      at: Date.now(),
      tools,
      ...(proposal ? { proposal } : {}),
    };
    this.patch({ chat: [...this.state.chat, answer].slice(-100) });
    return answer;
  }

  private brief() {
    const s = this.state;
    return {
      status: s.status,
      reason: s.reason,
      order: s.order,
      waits: s.waits,
      vars: s.vars,
      nodes: Object.fromEntries(
        Object.entries(s.nodes)
          .filter(([, n]) => n.status !== 'pending')
          .map(([id, n]) => [id, { status: n.status, summary: n.summary, error: n.error }]),
      ),
      recent: s.timeline.slice(-10).map((t) => t.message),
    };
  }

  private async runTool(tool: string, args: Record<string, unknown>) {
    const note = typeof args.note === 'string' ? args.note : undefined;
    const nodeId =
      typeof args.nodeId === 'string'
        ? args.nodeId
        : this.state.waits.find((w) => w.kind === 'approval')?.nodeId;
    switch (tool) {
      case 'get_state':
        return this.brief();
      // Decisions and cancellations are prepared here and confirmed by a person on the order page.
      case 'approve':
      case 'reject': {
        if (!nodeId || !this.state.waits.some((w) => w.kind === 'approval' && w.nodeId === nodeId))
          return { error: 'Nothing is waiting for approval' };
        const proposal: ChatProposal = {
          kind: 'decide',
          nodeId,
          decision: tool === 'approve' ? 'approved' : 'rejected',
          ...(note ? { note } : {}),
        };
        return { proposal };
      }
      case 'deliver_event':
        return this.deliver(String(args.event ?? ''));
      case 'cancel': {
        if (TERMINAL_ORDER_STATUSES.includes(this.state.status))
          return { error: 'The order has already finished' };
        const proposal: ChatProposal = {
          kind: 'cancel',
          reason: String(args.reason ?? 'Cancelled via chat'),
        };
        return { proposal };
      }
      default:
        return { error: `Unknown tool ${tool}` };
    }
  }

  private chatHeuristic(text: string, acted: boolean) {
    const t = text.toLowerCase();
    if (!acted) {
      if (/\bapprove\b/.test(t)) return { action: 'tool' as const, tool: 'approve', args: {} };
      if (/\breject\b/.test(t)) return { action: 'tool' as const, tool: 'reject', args: {} };
      if (/\bcancel\b/.test(t))
        return { action: 'tool' as const, tool: 'cancel', args: { reason: text } };
      const ev = /\b([a-z]+\.[a-z_]+)\b/.exec(t)?.[1];
      if (ev && /\b(send|deliver|mark|fire)\b/.test(t))
        return { action: 'tool' as const, tool: 'deliver_event', args: { event: ev } };
    }
    const s = this.state;
    const waiting = s.waits.map((w) => w.title).join('; ');
    return {
      action: 'reply' as const,
      reply: acted
        ? 'Done — the order will continue from there.'
        : `Order is ${s.status}${s.reason ? ` (${s.reason})` : ''}. Total ${s.order?.total.toFixed(2)} ${s.order?.currency}.${waiting ? ` Waiting on: ${waiting}.` : ''}`,
    };
  }
}

/** What the assistant says when it has prepared an action for a person to confirm. */
function proposalText(p: ChatProposal, s: OrderState) {
  if (p.kind === 'cancel')
    return `Ready to cancel this order (“${p.reason}”). Confirm below to go ahead.`;
  const step = s.flow?.nodes.find((n) => n.id === p.nodeId)?.label ?? p.nodeId;
  return `Ready to ${p.decision === 'approved' ? 'approve' : 'reject'} ${step}${p.note ? ` with the note “${p.note}”` : ''}. Confirm below to send it.`;
}
