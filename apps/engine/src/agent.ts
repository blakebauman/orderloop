/**
 * OrderAgent: one Agents SDK Durable Object per order. It holds the live run state that syncs to
 * every browser on the order page, records what the Workflow reports, owns the order's waits
 * (approvals and external events) and their delivery, and cancels with compensation. Questions
 * about an order go to the workspace assistant (./assistant), which reads and acts on it here.
 */

import {
  atLeast,
  decodePrincipal,
  type EdgeState,
  EMPTY_ORDER_STATE,
  eraseOrderState,
  type FlowVersion,
  MAX_EVENT_PAYLOAD_BYTES,
  type NodeRun,
  newId,
  type Order,
  type OrderState,
  type OrderStatus,
  type OutboundEvent,
  type PendingWait,
  type PlanNode,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  payloadFits,
  ROLE_LABELS,
  type Role,
  TERMINAL_ORDER_STATUSES,
  type TimelineEntry,
} from '@orderloop/core';
import { approvals, createDb, nodeRuns, orders } from '@orderloop/db';
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from 'agents';
import { and, eq } from 'drizzle-orm';
import { recordAudit } from './audit';
import { compensateOrder } from './connectors';
import { a2aAgent } from './namespaces';
import { emit, orderSummary } from './outbox';
import { livePrincipal, SESSION_ENDED } from './principal';
import { separationRefusal } from './separation';

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
/** Per-connection state: who opened the order page's socket. */
type ConnectionState = { principal: ProxiedPrincipal | null };

const TIMELINE_CAP = 400;
// Matches the Workflow's emit step: 5 retries with exponential backoff from 10 seconds.
const WEBHOOK_RETRIES = 5;

/** What an A2A watcher cares about: the order's status and what it waits on. */
const watchKey = (s: State) => `${s.status}|${s.waits.map((w) => w.eventType).join(',')}`;

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

  /** What the D1 index row last got from this object, so an unchanged report writes nothing. */
  private indexed: string | null = null;

  private async syncIndex() {
    const s = this.state;
    if (!s.orderId || !s.order) return;
    const row = {
      status: s.status,
      total: s.order.total,
      fxRate: s.order.fxRate ?? 1,
      customerId: s.order.customerId ?? null,
      title: s.order.title ?? '',
      instanceId: s.instanceId,
      generation: s.generation,
      waitingOn: s.waits.map((w) => w.title).join(' · ') || null,
      waitingAt:
        s.waits
          .map((w) => s.flow?.nodes.find((n) => n.id === w.nodeId)?.label ?? w.nodeId)
          .join(' · ') || null,
      waitingSince: s.waits.length ? Math.min(...s.waits.map((w) => w.since)) : null,
    };
    const key = JSON.stringify(row);
    if (key === this.indexed) return;
    await this.db()
      .update(orders)
      .set({ ...row, updatedAt: Date.now() })
      .where(eq(orders.id, s.orderId));
    this.indexed = key;
  }

  // ── Called by EngineApi and the Workflow ───────────────────────────────────

  async snapshot(): Promise<OrderState> {
    return this.state;
  }

  /**
   * Removes a data subject from this order (`eraseOrderState` in core) once it has finished, and
   * returns its erased title (`held` false when this object never held the order). Null while it
   * still runs: its steps may yet need the buyer's details.
   */
  async erasePersonalData(terms: string[]): Promise<{ held: boolean; title: string } | null> {
    if (!this.state.orderId) return { held: false, title: '' };
    if (!TERMINAL_ORDER_STATUSES.includes(this.state.status)) return null;
    this.setState({ ...eraseOrderState(this.state, terms), updatedAt: Date.now() });
    await this.syncIndex();
    return { held: true, title: this.state.order?.title ?? '' };
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
        model: s.order.model,
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
          ? `${w.title}: ${outcome === 'escalated' || outcome === 'timeout' ? 'timed out' : outcome}${payload.by ? ` by ${String(payload.by)}` : ''}${payload.note ? ` — “${String(payload.note)}”` : ''}`
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

  // ── Callable from the order page ──
  //
  // The web app proxies the page's WebSocket here with the signed-in principal in a header it sets
  // itself (PRINCIPAL_HEADER); `onConnect` keeps it on the connection. Each socket call re-reads a
  // person's session and user from D1, so signing out, a password reset, being disabled or a role
  // change applies to a page that is already open. The same methods called over RPC (EngineApi,
  // from the web app's own authorized routes) or by the Workflow have no connection and are trusted.

  override onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    connection.setState({ principal: decodePrincipal(ctx.request.headers.get(PRINCIPAL_HEADER)) });
  }

  /**
   * For a socket call, the caller as they are now if they hold at least `min`, else throws. For an
   * RPC call, null. A socket without a principal (which only a misconfigured proxy could open), or
   * whose session has ended, is refused and closed.
   */
  private async authorize(min: Role): Promise<Principal | null> {
    const { connection } = getCurrentAgent();
    if (!connection) return null;
    const stored = (connection.state as ConnectionState | null)?.principal ?? null;
    const p = stored ? await livePrincipal(this.env, stored) : null;
    if (!p) {
      // Close once the refusal has gone out, so the page can show why.
      setTimeout(() => connection.close(4401, 'Session ended'), 100);
      throw new Error(SESSION_ENDED);
    }
    if (!atLeast(p.role, min)) throw new Error(`This needs the ${ROLE_LABELS[min]} role.`);
    return p;
  }

  /** The caller as this agent sees them now: their current role, or a refusal if signed out. */
  @callable()
  async whoami() {
    const p = await this.authorize('viewer');
    return p ? { name: p.name, role: p.role } : null;
  }

  /**
   * Approve or reject the approval a node is waiting on. `deciderId` is the principal deciding,
   * from an RPC caller; on a socket it is the signed-in caller, whatever the page sent.
   */
  @callable()
  async decide(
    nodeId: string,
    decision: 'approved' | 'rejected',
    by = 'operator',
    note?: string,
    deciderId?: string,
  ) {
    const caller = await this.authorize('approver');
    if (decision !== 'approved' && decision !== 'rejected')
      throw new Error('decision must be approved or rejected');
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000))
      throw new Error('note must be at most 2000 characters');
    // On a socket the audit trail names the signed-in person, never what the page sent.
    if (caller) by = caller.email ?? caller.name;
    by = String(by).slice(0, 200);
    if (caller) deciderId = caller.id;
    const own = this.state.orderId
      ? await separationRefusal(this.env, this.state.orderId, deciderId)
      : null;
    if (own) throw new Error(own);
    const w = this.state.waits.find((x) => x.kind === 'approval' && x.nodeId === nodeId);
    if (!w || !this.state.instanceId) throw new Error('That node is not waiting for an approval');
    const instance = await this.env.ORDER_LOOP.get(this.state.instanceId);
    await instance.sendEvent({ type: w.eventType, payload: { decision, by, note: note ?? null } });
    // On the order page's socket; an RPC caller (the web app, the assistant) records its own.
    if (caller)
      await recordAudit(this.env, 'approval.decided', {
        actor: caller,
        target: this.state.orderId,
        detail: { nodeId, decision, ...(note ? { note } : {}), via: 'app' },
      });
    return { ok: true };
  }

  /** Deliver a business event (e.g. "payment.received") to whichever node waits for it. */
  @callable()
  async deliver(event: string, payload: Record<string, unknown> = {}) {
    const caller = await this.authorize('operator');
    // The payload lands in the order's variables, every broadcast and the next generation.
    if (typeof event !== 'string' || !event || event.length > 100)
      throw new Error('event must be a name of at most 100 characters');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payloadFits(payload))
      throw new Error(`payload must be an object of at most ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
    const w = this.state.waits.find((x) => x.kind === 'event' && x.event === event);
    if (!w || !this.state.instanceId) return { delivered: false };
    const instance = await this.env.ORDER_LOOP.get(this.state.instanceId);
    await instance.sendEvent({ type: w.eventType, payload: { ...payload, event, at: Date.now() } });
    if (caller)
      await recordAudit(this.env, 'order.event_delivered', {
        actor: caller,
        target: this.state.orderId,
        detail: { event, nodeId: w.nodeId, via: 'app' },
      });
    return { delivered: true, nodeId: w.nodeId };
  }

  /** Set while a cancel runs, so a second cancel arriving during its awaits does nothing. */
  private cancelling = false;

  @callable()
  async cancel(reason = 'Cancelled by operator') {
    const caller = await this.authorize('operator');
    reason = String(reason).slice(0, 500);
    if (this.cancelling || TERMINAL_ORDER_STATUSES.includes(this.state.status))
      return { ok: false };
    this.cancelling = true;
    try {
      const done = await this.cancelOrder(reason);
      if (caller)
        await recordAudit(this.env, 'order.cancelled', {
          actor: caller,
          target: this.state.orderId,
          detail: { reason, via: 'app' },
        });
      return done;
    } finally {
      this.cancelling = false;
    }
  }

  private async cancelOrder(reason: string) {
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
        message: `Cancelled: ${reason}${undone ? ` (released ${undone.released}, voided ${undone.voided}, cancelled ${undone.cancelled} shipments${undone.restored ? `, restocked ${undone.restored} lines` : ''}${undone.invoicesVoided ? `, voided ${undone.invoicesVoided} invoices` : ''}${undone.invoicesPaid.length ? `, left paid invoices ${undone.invoicesPaid.join(', ')}` : ''}${undone.unbilled ? `, reversed ${undone.unbilled} account charges` : ''}${undone.sellerOrdersCancelled ? `, ${undone.sellerOrdersCancelled} seller orders` : ''}${undone.payoutsReversed ? `, reversed ${undone.payoutsReversed} payouts` : ''}${undone.revoked ? `, revoked ${undone.revoked} codes` : ''})` : ''}`,
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

  // ── A2A watchers ──
  // An A2A task that follows this order (apps/engine/src/a2a/) registers its caller's A2AAgent
  // here, and is told whenever the order's status or waits change, so the task can push the update
  // after the request that started it has ended.

  private watchers(): string[] {
    this.sql`CREATE TABLE IF NOT EXISTS a2a_watchers (name TEXT PRIMARY KEY)`;
    return this.sql<{ name: string }>`SELECT name FROM a2a_watchers`.map((r) => r.name);
  }

  /** Registers an A2AAgent (by name) to hear about this order. Repeats are harmless. */
  async watch(name: string) {
    this.watchers();
    this.sql`INSERT OR IGNORE INTO a2a_watchers (name) VALUES (${name})`;
  }

  override onStateChanged(state: State | undefined) {
    if (!state?.orderId || !this.watchers().length) return;
    this.sql`CREATE TABLE IF NOT EXISTS a2a_watch_state (id INTEGER PRIMARY KEY, key TEXT)`;
    const key = watchKey(state);
    const last = this.sql<{ key: string }>`SELECT key FROM a2a_watch_state WHERE id = 1`[0]?.key;
    if (key === last) return;
    this.sql`INSERT OR REPLACE INTO a2a_watch_state (id, key) VALUES (1, ${key})`;
    this.ctx.waitUntil(this.schedule(0, 'notifyWatchers', { names: this.watchers(), attempt: 0 }));
  }

  /**
   * Tells each watcher the order moved. A watcher that can't be reached is retried with the
   * webhooks' backoff; once the order has finished and everyone has heard, the list is cleared.
   */
  async notifyWatchers(p: { names: string[]; attempt: number }) {
    const orderId = this.state.orderId;
    if (!orderId) return;
    const missed: string[] = [];
    for (const name of p.names) {
      try {
        await a2aAgent(this.env, name).orderChanged(orderId);
      } catch (err) {
        console.warn('a2a watcher', name, err);
        missed.push(name);
      }
    }
    if (missed.length && p.attempt < WEBHOOK_RETRIES)
      await this.schedule(10 * 2 ** p.attempt, 'notifyWatchers', {
        names: missed,
        attempt: p.attempt + 1,
      });
    else if (TERMINAL_ORDER_STATUSES.includes(this.state.status))
      this.sql`DELETE FROM a2a_watchers`;
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
}
