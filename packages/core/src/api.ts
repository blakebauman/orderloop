/**
 * The contract between the web app and the engine's `EngineApi` RPC entrypoint, and the state
 * each order's OrderAgent syncs to browsers. The web app types its service binding with
 * `EngineRpc` rather than importing engine source.
 */

import type { EdgeState, GraphIssue } from './graph';
import type { HealthReport } from './health';
import type {
  FlowGraph,
  FlowVersion,
  NodeStatus,
  Order,
  OrderInputDraft,
  OrderModel,
  OrderStatus,
  PendingWait,
  TimelineEntry,
} from './types';

export type NodeRun = {
  status: NodeStatus;
  runs: number;
  /** One line for the node card, e.g. "Reserved 3 lines" or "→ needs_approval". */
  summary?: string;
  output?: unknown;
  error?: string;
  branches?: string[];
  startedAt?: number;
  endedAt?: number;
};

/** The OrderAgent's synced state: everything the order page renders. */
export type OrderState = {
  orderId: string | null;
  status: OrderStatus;
  order: Order | null;
  flow: FlowVersion | null;
  nodes: Record<string, NodeRun>;
  edges: Record<string, EdgeState>;
  waits: PendingWait[];
  vars: Record<string, unknown>;
  timeline: TimelineEntry[];
  /** Workflow instance currently driving the order. */
  instanceId: string | null;
  /** 1 for the first run; increments on each "continue as new". */
  generation: number;
  rollback: { outcome: 'complete' | 'failed'; error: string | null } | null;
  /** Reason when cancelled or failed. */
  reason?: string;
  updatedAt: number;
};

export const EMPTY_ORDER_STATE: OrderState = {
  orderId: null,
  status: 'queued',
  order: null,
  flow: null,
  nodes: {},
  edges: {},
  waits: [],
  vars: {},
  timeline: [],
  instanceId: null,
  generation: 0,
  rollback: null,
  updatedAt: 0,
};

/** The largest event payload (JSON) an order accepts; it lands in the order's variables. */
export const MAX_EVENT_PAYLOAD_BYTES = 32 * 1024;

/** True when a payload fits `MAX_EVENT_PAYLOAD_BYTES` once serialized. */
export function payloadFits(payload: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(payload ?? {})).byteLength <= MAX_EVENT_PAYLOAD_BYTES
  );
}

export type StartOrderInput = {
  flowId: string;
  /** Published version to run; defaults to the latest. */
  version?: number;
  input: OrderInputDraft;
  vars?: Record<string, unknown>;
  /**
   * The principal id starting it, set by the caller's server, never from a request body. Recorded
   * on the order, and not part of the fingerprint.
   */
  startedBy?: string;
};

export type StartOrderResult = { orderId: string; replayed?: boolean };

/** A repeat of the same key and request returns the order it already created. */
export type StartOrderOnceInput = StartOrderInput & {
  idempotencyKey: string;
  /**
   * What a replay must match, when the caller knows better than the start request: an inbound
   * order fingerprints the sender's payload, so a retry still matches after the routing changes.
   */
  fingerprint?: string;
};

export type StartOrderOnceResult =
  | StartOrderResult
  /** The key already started an order from a different request. */
  | { mismatch: true };

/**
 * SHA-256 of what an order start asked for, with object keys sorted so property order doesn't
 * matter. A replayed idempotency key must carry the same fingerprint.
 */
export function startFingerprint(req: StartOrderInput): Promise<string> {
  return fingerprintOf({
    flowId: req.flowId,
    version: req.version ?? null,
    input: req.input,
    vars: req.vars ?? {},
  });
}

/** SHA-256 of any JSON value, with object keys sorted so property order doesn't matter. */
export async function fingerprintOf(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type CopilotRequest = {
  prompt: string;
  /** The graph being edited; omitted to create a new flow. */
  graph?: FlowGraph;
  model?: OrderModel;
};

export type CopilotResult = {
  graph: FlowGraph;
  /** What the copilot says it changed. */
  explanation: string;
  errors: GraphIssue[];
  warnings: GraphIssue[];
};

/**
 * A payment provider's webhook event, already verified by the web app: Stripe's event id, its type
 * (`invoice.paid`…) and the object it is about.
 */
export type PaymentEvent = {
  provider: 'stripe';
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

/**
 * `handled` (acted on), `duplicate` (this event id was handled before), `ignored` (not a type or an
 * object OrderLoop acts on), or `retry`: the order isn't waiting for it yet, so the provider
 * should deliver it again later.
 */
export type PaymentEventResult = {
  outcome: 'handled' | 'duplicate' | 'ignored' | 'retry';
  orderId?: string;
  /** The order event delivered to a waiting node (`payment.received`, `payment.disputed`). */
  delivered?: string;
  reason?: string;
};

export interface EngineRpc {
  startOrder(input: StartOrderInput): Promise<StartOrderResult>;
  /** Starts an order at most once per idempotency key. */
  startOrderOnce(input: StartOrderOnceInput): Promise<StartOrderOnceResult>;
  /** Delivers a business event (e.g. "payment.received") to whichever node waits for it. */
  sendEvent(
    orderId: string,
    event: string,
    payload?: Record<string, unknown>,
  ): Promise<{ delivered: boolean; nodeId?: string; notFound?: true }>;
  /** A verified payment provider event (Stripe): settles invoices and resumes the order. */
  paymentEvent(event: PaymentEvent): Promise<PaymentEventResult>;
  /** `by` is who the record names; `deciderId` the principal, checked against the order's starter. */
  decide(
    orderId: string,
    nodeId: string,
    decision: 'approved' | 'rejected',
    by: string,
    deciderId: string,
    note?: string,
  ): Promise<
    { ok: true } | { ok: false; reason: 'not_found' | 'not_waiting' | 'own_order'; error?: string }
  >;
  /** `finished` when the order had already ended, so there was nothing to cancel. */
  cancel(
    orderId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'finished' }>;
  snapshot(orderId: string): Promise<OrderState | null>;
  copilot(req: CopilotRequest): Promise<CopilotResult>;
  /** Email intake: mailbox local part → flow id, from the engine's INTAKE_MAILBOXES. */
  intakeMailboxes(): Promise<Record<string, string>>;
  /** Runs the stock review now (normally a daily cron on the Replenish Workflow). */
  runReplenish(): Promise<{ instanceId: string }>;
  /** Deep health: the engine's own D1 and R2 bindings answer. */
  health(): Promise<HealthReport>;
}
