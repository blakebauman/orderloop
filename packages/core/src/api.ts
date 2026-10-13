/**
 * The contract between the web app and the engine's `EngineApi` RPC entrypoint, and the state
 * each order's OrderAgent syncs to browsers. The web app types its service binding with
 * `EngineRpc` rather than importing engine source.
 */

import type { EdgeState, GraphIssue } from './graph';
import type {
  FlowGraph,
  FlowVersion,
  NodeStatus,
  Order,
  OrderInput,
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

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  /** Tools the assistant called while answering. */
  tools?: { name: string; args: unknown; result: unknown }[];
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
  chat: ChatMessage[];
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
  chat: [],
  instanceId: null,
  generation: 0,
  rollback: null,
  updatedAt: 0,
};

export type StartOrderInput = {
  flowId: string;
  /** Published version to run; defaults to the latest. */
  version?: number;
  input: OrderInput;
  vars?: Record<string, unknown>;
};

export type CopilotRequest = {
  prompt: string;
  /** The graph being edited; omitted to create a new flow. */
  graph?: FlowGraph;
  orderType?: string;
};

export type CopilotResult = {
  graph: FlowGraph;
  /** What the copilot says it changed. */
  explanation: string;
  errors: GraphIssue[];
  warnings: GraphIssue[];
};

export interface EngineRpc {
  startOrder(input: StartOrderInput): Promise<{ orderId: string }>;
  /** Delivers a business event (e.g. "payment.received") to whichever node waits for it. */
  sendEvent(
    orderId: string,
    event: string,
    payload?: Record<string, unknown>,
  ): Promise<{ delivered: boolean; nodeId?: string }>;
  decide(
    orderId: string,
    nodeId: string,
    decision: 'approved' | 'rejected',
    by: string,
    note?: string,
  ): Promise<void>;
  cancel(orderId: string, reason: string): Promise<void>;
  snapshot(orderId: string): Promise<OrderState | null>;
  copilot(req: CopilotRequest): Promise<CopilotResult>;
  /** Runs the stock review now (normally a daily cron on the Replenish Workflow). */
  runReplenish(): Promise<{ instanceId: string }>;
}
