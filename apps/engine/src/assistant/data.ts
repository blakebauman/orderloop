/**
 * What the assistant reads and does, independent of the model. Every function takes the caller as
 * they are now and refuses what their role doesn't allow, so a tool can never do more than the
 * person asking could do themselves. Writes go through the same agents and helpers the pages use;
 * the audit trail names the person and the channel: "via assistant", "via MCP" or "via A2A".
 */

import {
  type ActionPreview,
  ASSISTANT_TOOLS,
  type AssessQuestions,
  type AssistantTool,
  type Attention,
  atLeast,
  BASE_CURRENCY,
  describeDiff,
  type Flow,
  type FlowGraph,
  type FlowProposal,
  flowGraphSchema,
  graphDiff,
  ORDER_MODEL_LABELS,
  ORDER_MODELS,
  type OrderChannel,
  type OrderModel,
  type OrderState,
  type Principal,
  ROLE_LABELS,
  TERMINAL_ORDER_STATUSES,
  validateGraph,
} from '@orderloop/core';
import {
  approvals,
  contains,
  createDb,
  customers,
  endsWith,
  flows,
  getFlowVersionJson,
  orders,
  products,
  publishFlow,
} from '@orderloop/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { copilot, orderBrief } from '../ai';
import { assess, resolveImages } from '../clef';

export class Refused extends Error {}

export function requireRole(p: Principal, tool: AssistantTool) {
  const min = ASSISTANT_TOOLS[tool].role;
  if (!atLeast(p.role, min)) throw new Refused(`This needs the ${ROLE_LABELS[min]} role.`);
}

/** Where a tool call came from: the workspace assistant, an MCP client or an A2A agent. */
export type Channel = 'assistant' | 'MCP' | 'A2A';

/** How the audit trail names an act taken for someone through a channel. */
export const via = (p: Principal, channel: Channel) => `${p.email ?? p.name} via ${channel}`;

export function money(n: number | null | undefined, currency = BASE_CURRENCY) {
  if (n === null || n === undefined) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const orderRef = (id: string) => `#${id.slice(-6)}`;

const DAY = 86_400_000;
const LIST_CAP = 6;

// ── Reads ──────────────────────────────────────────────────────────────────

export async function attention(env: Env): Promise<Attention> {
  const db = createDb(env.DB);
  const now = Date.now();
  const failedWhere = and(
    inArray(orders.status, ['failed', 'rolled_back']),
    gte(orders.updatedAt, now - 3 * DAY),
  );
  const stalledWhere = and(
    eq(orders.status, 'waiting'),
    isNotNull(orders.waitingOn),
    lte(orders.updatedAt, now - DAY),
  );
  const n = sql<number>`count(*)`;
  const [pending, pendingN, failed, failedN, stalled, stalledN] = await Promise.all([
    db
      .select({
        id: approvals.id,
        orderId: approvals.orderId,
        nodeId: approvals.nodeId,
        title: approvals.title,
        amount: approvals.amount,
        requestedAt: approvals.requestedAt,
      })
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
      .orderBy(asc(approvals.requestedAt))
      .limit(LIST_CAP),
    db.select({ n }).from(approvals).where(eq(approvals.status, 'pending')).get(),
    db
      .select({
        id: orders.id,
        title: orders.title,
        status: orders.status,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .where(failedWhere)
      .orderBy(desc(orders.updatedAt))
      .limit(LIST_CAP),
    db.select({ n }).from(orders).where(failedWhere).get(),
    db
      .select({
        id: orders.id,
        title: orders.title,
        waitingOn: orders.waitingOn,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .where(stalledWhere)
      .orderBy(asc(orders.updatedAt))
      .limit(LIST_CAP),
    db.select({ n }).from(orders).where(stalledWhere).get(),
  ]);
  // A wait for a person shows under approvals already; stalled means waiting on a business event.
  const awaitingPeople = new Set(pending.map((a) => a.orderId));
  return {
    approvals: pending,
    failed,
    stalled: stalled.filter((o) => !awaitingPeople.has(o.id)),
    counts: { approvals: pendingN?.n ?? 0, failed: failedN?.n ?? 0, stalled: stalledN?.n ?? 0 },
  };
}

export type FindOrders = {
  status?: string;
  model?: string;
  channel?: string;
  customer?: string;
  q?: string;
  minTotal?: number;
  maxTotal?: number;
  sinceDays?: number;
  sort?: 'newest' | 'updated' | 'largest';
  limit?: number;
};

export async function findOrders(env: Env, f: FindOrders) {
  const db = createDb(env.DB);
  // Totals compare in the base currency, at each order's own rate.
  const base = sql<number>`(${orders.total} / ${orders.fxRate})`;
  const where = and(
    f.status ? eq(orders.status, f.status) : undefined,
    f.model ? eq(orders.model, f.model) : undefined,
    f.channel ? eq(orders.channel, f.channel) : undefined,
    f.customer
      ? or(contains(customers.name, f.customer), eq(orders.customerId, f.customer))
      : undefined,
    f.q
      ? or(contains(orders.id, f.q), contains(orders.title, f.q), contains(customers.name, f.q))
      : undefined,
    f.minTotal !== undefined ? gte(base, f.minTotal) : undefined,
    f.maxTotal !== undefined ? lte(base, f.maxTotal) : undefined,
    f.sinceDays ? gte(orders.createdAt, Date.now() - f.sinceDays * DAY) : undefined,
  );
  const sort =
    f.sort === 'largest'
      ? desc(base)
      : f.sort === 'updated'
        ? desc(orders.updatedAt)
        : desc(orders.createdAt);
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 50);
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: orders.id,
        title: orders.title,
        model: orders.model,
        channel: orders.channel,
        status: orders.status,
        customer: customers.name,
        total: orders.total,
        currency: orders.currency,
        waitingOn: orders.waitingOn,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where)
      .orderBy(sort)
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)`, sum: sql<number>`coalesce(sum(${base}), 0)` })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where)
      .get(),
  ]);
  return {
    count: totals?.n ?? 0,
    total: money(totals?.sum ?? 0),
    shown: rows.length,
    orders: rows.map((r) => ({
      ...r,
      ref: orderRef(r.id),
      total: money(r.total, r.currency),
      href: `/orders/${r.id}`,
    })),
  };
}

/** An order id from a full id, a `#abc123` reference or its last characters. */
export async function resolveOrderId(env: Env, ref: string): Promise<string | null> {
  const id = ref.trim().replace(/^#/, '');
  if (!id) return null;
  const db = createDb(env.DB);
  const exact = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).get();
  if (exact) return exact.id;
  const tail = await db
    .select({ id: orders.id })
    .from(orders)
    .where(endsWith(orders.id, id))
    .limit(2);
  return tail.length === 1 ? tail[0]!.id : null;
}

export async function snapshot(env: Env, orderId: string): Promise<OrderState | null> {
  const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
  return s.orderId ? s : null;
}

async function loadOrder(env: Env, ref: string) {
  const id = await resolveOrderId(env, ref);
  const s = id ? await snapshot(env, id) : null;
  if (!id || !s) throw new Refused(`No order matches ${ref}.`);
  return { id, s };
}

/**
 * Typed questions about one order, answered with a probability per option. Images are limited to
 * this order's documents (or https and data URLs), as for the Assess node.
 */
export async function assessOrder(
  env: Env,
  ref: string,
  questions: AssessQuestions,
  imageRefs: string[] = [],
) {
  const { id, s } = await loadOrder(env, ref);
  const { images, notes } = await resolveImages(env, imageRefs, id);
  const { value, source } = await assess(env, {
    state: { order: orderBrief(s.order!), status: s.status, vars: s.vars },
    questions,
    images,
  });
  return { id, ref: orderRef(id), answers: value.answers, images: images.length, notes, source };
}

const label = (s: OrderState, nodeId: string) =>
  s.flow?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

/** The step an output leads to, e.g. where "approved" goes from an approval. */
function nextStep(s: OrderState, nodeId: string, handle?: string) {
  const edge = s.flow?.edges.find(
    (e) => e.source === nodeId && (handle ? e.sourceHandle === handle : !e.sourceHandle),
  );
  return edge ? label(s, edge.target) : null;
}

export async function getOrder(env: Env, ref: string) {
  const { id, s } = await loadOrder(env, ref);
  const o = s.order!;
  const customer = o.customerId
    ? await createDb(env.DB)
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, o.customerId))
        .get()
    : null;
  return {
    id,
    ref: orderRef(id),
    href: `/orders/${id}`,
    title: o.title || ORDER_MODEL_LABELS[o.model as OrderModel],
    model: o.model,
    channel: o.channel,
    status: s.status,
    reason: s.reason,
    customer: customer?.name ?? o.customerId ?? null,
    total: money(o.total, o.currency),
    lines: o.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    flow: s.flow ? `${s.flow.name} v${s.flow.version}` : null,
    waits: s.waits.map((w) => ({
      nodeId: w.nodeId,
      kind: w.kind,
      title: w.title,
      event: w.event,
      assignee: w.assignee,
      amount: w.amount === undefined ? undefined : money(w.amount, o.currency),
      deadline: w.deadline ? new Date(w.deadline).toISOString() : undefined,
      onApprove: w.kind === 'approval' ? nextStep(s, w.nodeId, 'approved') : undefined,
      onReject: w.kind === 'approval' ? nextStep(s, w.nodeId, 'rejected') : undefined,
    })),
    steps: Object.entries(s.nodes)
      .filter(([, n]) => n.status !== 'pending')
      .map(([nodeId, n]) => ({
        nodeId,
        step: label(s, nodeId),
        status: n.status,
        summary: n.summary,
        error: n.error,
      })),
    recent: s.timeline
      .slice(-12)
      .map((t) => ({ at: new Date(t.at).toISOString(), message: t.message })),
  };
}

export async function findProducts(env: Env, q?: string, belowReorder?: boolean) {
  const db = createDb(env.DB);
  const available = sql<number>`(${products.stock} - ${products.reserved})`;
  const rows = await db
    .select({
      sku: products.sku,
      name: products.name,
      stock: products.stock,
      reserved: products.reserved,
      available,
      reorderPoint: products.reorderPoint,
      supplier: products.supplier,
    })
    .from(products)
    .where(
      and(
        q ? or(contains(products.sku, q), contains(products.name, q)) : undefined,
        belowReorder ? lte(available, products.reorderPoint) : undefined,
      ),
    )
    .orderBy(asc(products.sku))
    .limit(40);
  return { products: rows, href: '/back-office' };
}

export async function listFlows(env: Env) {
  const rows = await createDb(env.DB)
    .select({
      id: flows.id,
      name: flows.name,
      model: flows.model,
      channels: flows.channels,
      publishedVersion: flows.publishedVersion,
      updatedAt: flows.updatedAt,
    })
    .from(flows)
    .orderBy(asc(flows.name));
  return { flows: rows.map((f) => ({ ...f, href: `/flows/${f.id}` })) };
}

async function loadFlow(env: Env, flowId: string) {
  const row = await createDb(env.DB).select().from(flows).where(eq(flows.id, flowId)).get();
  if (!row) throw new Refused(`No flow has the id ${flowId}.`);
  const graph = flowGraphSchema.parse(JSON.parse(row.graphJson));
  const flow: Flow = {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model as OrderModel,
    channels: JSON.parse(row.channels) as OrderChannel[],
    ...graph,
  };
  return { row, flow };
}

export async function getFlow(env: Env, flowId: string) {
  const { row, flow } = await loadFlow(env, flowId);
  const { errors, warnings } = validateGraph(flow);
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    channels: flow.channels,
    publishedVersion: row.publishedVersion,
    href: `/flows/${row.id}`,
    steps: flow.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })),
    connections: flow.edges.map(
      (e) => `${e.source}${e.sourceHandle ? `:${e.sourceHandle}` : ''} → ${e.target}`,
    ),
    errors: errors.map((e) => e.message),
    warnings: warnings.map((e) => e.message),
  };
}

/**
 * A whole proposed graph for the editor to show; nothing is saved. Starts from the graph on the
 * person's screen when they are editing this flow, so unsaved work is kept.
 */
export async function proposeFlowChange(
  env: Env,
  flowId: string,
  instruction: string,
  onScreen?: { graph?: FlowGraph; model?: string },
): Promise<FlowProposal> {
  const { flow } = await loadFlow(env, flowId);
  const start = onScreen?.graph ?? { nodes: flow.nodes, edges: flow.edges };
  const res = await copilot(env, {
    prompt: instruction,
    graph: start,
    model: ORDER_MODELS.find((m) => m === onScreen?.model) ?? flow.model,
  });
  return {
    flowId,
    flowName: flow.name,
    explanation: res.explanation,
    graph: res.graph,
    errors: res.errors,
    warnings: res.warnings,
    changes: graphDiff(start, res.graph),
  };
}

// ── Actions that wait for a person ─────────────────────────────────────────

export type ActionInput = {
  decide_approval: {
    orderId: string;
    nodeId?: string;
    decision: 'approved' | 'rejected';
    note?: string;
  };
  deliver_event: { orderId: string; event: string };
  cancel_order: { orderId: string; reason: string };
  publish_flow: { flowId: string };
  run_stock_review: Record<string, never>;
};
export type ActionTool = keyof ActionInput;

/** The approval wait a decision is for: the one named, or the only one open. */
function approvalWait(s: OrderState, nodeId?: string) {
  const open = s.waits.filter((w) => w.kind === 'approval');
  return nodeId ? open.find((w) => w.nodeId === nodeId) : open.length === 1 ? open[0] : undefined;
}

const ROLLBACK_EFFECTS: Record<string, string> = {
  'commerce.reserve_inventory': 'Releases the stock it reserved',
  'commerce.authorize_payment': 'Voids the payment authorization',
  'commerce.ship': 'Cancels the shipment',
};

/**
 * The action resolved against live data, for the confirm card: what will happen, or why it can't.
 * Read-only; the same checks run again when the person confirms.
 */
export async function previewAction<T extends ActionTool>(
  env: Env,
  p: Principal,
  tool: T,
  input: ActionInput[T],
): Promise<ActionPreview> {
  const min = ASSISTANT_TOOLS[tool].role;
  const roleBlock = atLeast(p.role, min) ? undefined : `This needs the ${ROLE_LABELS[min]} role.`;
  try {
    switch (tool) {
      case 'decide_approval': {
        const i = input as ActionInput['decide_approval'];
        const { id, s } = await loadOrder(env, i.orderId);
        const w = approvalWait(s, i.nodeId);
        const o = s.order!;
        const verb = i.decision === 'approved' ? 'Approve' : 'Reject';
        const next = w ? nextStep(s, w.nodeId, i.decision) : null;
        return {
          title: `${verb} ${orderRef(id)}${w ? ` · ${label(s, w.nodeId)}` : ''}`,
          href: `/orders/${id}`,
          consequences: [
            `${o.title || ORDER_MODEL_LABELS[o.model as OrderModel]} · ${money(o.total, o.currency)}`,
            next ? `The order goes on to ${next}` : 'The order continues from this approval',
            i.note ? `Note: “${i.note}”` : 'No note',
          ],
          blocked:
            roleBlock ??
            (w
              ? undefined
              : s.waits.some((x) => x.kind === 'approval')
                ? 'This order has more than one approval open. Name the step.'
                : 'Nothing on this order is waiting for an approval now.'),
        };
      }
      case 'deliver_event': {
        const i = input as ActionInput['deliver_event'];
        const { id, s } = await loadOrder(env, i.orderId);
        const w = s.waits.find((x) => x.kind === 'event' && x.event === i.event);
        const next = w ? nextStep(s, w.nodeId) : null;
        return {
          title: `Deliver ${i.event} to ${orderRef(id)}`,
          href: `/orders/${id}`,
          consequences: w
            ? [`Resumes ${w.title}`, next ? `Then ${next} runs` : 'The order continues from there']
            : [],
          blocked:
            roleBlock ??
            (w
              ? undefined
              : `Nothing on this order is waiting for ${i.event}.${
                  s.waits.length
                    ? ` It waits for: ${s.waits.map((x) => x.event ?? x.title).join(', ')}.`
                    : ''
                }`),
        };
      }
      case 'cancel_order': {
        const i = input as ActionInput['cancel_order'];
        const { id, s } = await loadOrder(env, i.orderId);
        const o = s.order!;
        const undo = [
          ...new Set(
            (s.flow?.nodes ?? [])
              .filter((n) => s.nodes[n.id]?.status === 'succeeded' && ROLLBACK_EFFECTS[n.type])
              .map((n) => ROLLBACK_EFFECTS[n.type]!),
          ),
        ];
        return {
          title: `Cancel ${orderRef(id)}`,
          href: `/orders/${id}`,
          consequences: [
            `${o.title || ORDER_MODEL_LABELS[o.model as OrderModel]} · ${money(o.total, o.currency)}`,
            ...undo,
            ...(s.waits.some((w) => w.kind === 'approval') ? ['Closes its open approvals'] : []),
            'Sends order.cancelled to webhook subscribers',
            `Reason: “${i.reason}”`,
          ],
          blocked:
            roleBlock ??
            (TERMINAL_ORDER_STATUSES.includes(s.status)
              ? `This order has already finished (${s.status.replace('_', ' ')}).`
              : undefined),
        };
      }
      case 'publish_flow': {
        const i = input as ActionInput['publish_flow'];
        const { row, flow } = await loadFlow(env, i.flowId);
        const { errors } = validateGraph(flow);
        const live = row.publishedVersion
          ? await getFlowVersionJson(createDb(env.DB), row.id, row.publishedVersion)
          : null;
        const diff = live
          ? describeDiff(graphDiff(live.flow as unknown as FlowGraph, flow))
          : 'First version';
        const next = (row.publishedVersion ?? 0) + 1;
        return {
          title: `Publish ${row.name} v${next}`,
          href: `/flows/${row.id}`,
          consequences: [
            live
              ? `${diff ?? 'No changes'} since v${row.publishedVersion}`
              : 'This is the first version',
            `New ${ORDER_MODEL_LABELS[flow.model]} orders run it; orders already running keep their version`,
            'Publishes the saved draft. Unsaved changes in an open editor are not included',
          ],
          blocked:
            roleBlock ??
            (errors.length
              ? `The draft has ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix first: ${errors[0]!.message}`
              : live && !diff
                ? `Nothing to publish: v${row.publishedVersion} is current.`
                : undefined),
        };
      }
      case 'run_stock_review': {
        const low = (await findProducts(env, undefined, true)).products;
        return {
          title: 'Run the stock review now',
          href: '/back-office',
          consequences: [
            low.length
              ? `Starts a reorder for ${low.length} SKU${low.length === 1 ? '' : 's'} at or below the reorder point: ${low
                  .slice(0, 5)
                  .map((x) => x.sku)
                  .join(', ')}${low.length > 5 ? '…' : ''}`
              : 'No SKU is at or below its reorder point, so it should start nothing',
            'The same review runs every day at 06:00 UTC',
          ],
          blocked: roleBlock,
        };
      }
    }
  } catch (err) {
    if (err instanceof Refused)
      return { title: ASSISTANT_TOOLS[tool].label, consequences: [], blocked: err.message };
    throw err;
  }
  return { title: ASSISTANT_TOOLS[tool].label, consequences: [], blocked: 'Unknown action.' };
}

/** Carries out a confirmed action as the person, after checking it can still go ahead. */
export async function runAction<T extends ActionTool>(
  env: Env,
  p: Principal,
  tool: T,
  input: ActionInput[T],
  channel: Channel = 'assistant',
) {
  requireRole(p, tool);
  const preview = await previewAction(env, p, tool, input);
  if (preview.blocked) throw new Refused(preview.blocked);
  const by = via(p, channel);
  switch (tool) {
    case 'decide_approval': {
      const i = input as ActionInput['decide_approval'];
      const { id, s } = await loadOrder(env, i.orderId);
      const w = approvalWait(s, i.nodeId)!;
      await env.ORDER_AGENT.getByName(id).decide(w.nodeId, i.decision, by, i.note);
      return { done: preview.title, href: preview.href };
    }
    case 'deliver_event': {
      const i = input as ActionInput['deliver_event'];
      const { id } = await loadOrder(env, i.orderId);
      const r = await env.ORDER_AGENT.getByName(id).deliver(i.event, { by });
      if (!r.delivered) throw new Refused(`Nothing on ${orderRef(id)} was waiting for ${i.event}.`);
      return { done: preview.title, href: preview.href };
    }
    case 'cancel_order': {
      const i = input as ActionInput['cancel_order'];
      const { id } = await loadOrder(env, i.orderId);
      await env.ORDER_AGENT.getByName(id).cancel(`${i.reason} (${by})`);
      return { done: preview.title, href: preview.href };
    }
    case 'publish_flow': {
      const i = input as ActionInput['publish_flow'];
      const { flow } = await loadFlow(env, i.flowId);
      const version = await publishFlow(createDb(env.DB), {
        ...flow,
        nodes: flow.nodes,
        edges: flow.edges,
      });
      return { done: `Published ${flow.name} v${version}`, href: `/flows/${flow.id}`, version };
    }
    case 'run_stock_review': {
      const instance = await env.REPLENISH.create({ params: {} });
      return { done: 'Started the stock review', href: '/back-office', instanceId: instance.id };
    }
  }
  throw new Refused('Unknown action.');
}
