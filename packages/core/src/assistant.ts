/**
 * The workspace assistant's contract between the engine's AssistantAgent and the web app's panel.
 * One assistant per person; the page they are on travels with each message as its context.
 */

import type { GraphIssue } from './graph';
import type { Role } from './roles';
import type { FlowGraph } from './types';

/** What the assistant is looking at: everything, or the order or flow open on the page. */
export type AssistantContext =
  | { kind: 'workspace' }
  | { kind: 'order'; id: string; label: string }
  | {
      kind: 'flow';
      id: string;
      label: string;
      /** The editor's graph, unsaved changes included, so a proposal builds on what is on screen. */
      graph?: FlowGraph;
      model?: string;
    };

/** What is waiting on a person, for the line at the top of the panel. */
export type Attention = {
  approvals: {
    id: string;
    orderId: string;
    nodeId: string;
    title: string;
    amount: number | null;
    requestedAt: number;
  }[];
  /** Orders that failed or rolled back recently. */
  failed: { id: string; title: string; status: string; updatedAt: number }[];
  /** Orders waiting on an event for longer than a day. */
  stalled: { id: string; title: string; waitingOn: string | null; updatedAt: number }[];
  /** Totals; the lists above are capped. */
  counts: { approvals: number; failed: number; stalled: number };
};

export type AssistantTool =
  | 'needs_attention'
  | 'find_orders'
  | 'get_order'
  | 'assess_order'
  | 'find_products'
  | 'list_flows'
  | 'get_flow'
  | 'propose_flow_change'
  | 'decide_approval'
  | 'deliver_event'
  | 'cancel_order'
  | 'publish_flow'
  | 'run_stock_review';

/**
 * Who may use each tool, and which ones stop for a person to confirm. Reads and drafts run
 * directly; anything that decides, moves money, cancels or publishes waits for a confirm. A tool
 * the caller's role can't use is never offered to the model, and is refused if called anyway.
 *
 * The same tools are served over MCP (`/mcp`): `title` and `description` are what an MCP client
 * shows, and `label` is the assistant panel's chip for a call.
 */
export const ASSISTANT_TOOLS: Record<
  AssistantTool,
  { role: Role; confirm: boolean; label: string; title: string; description: string }
> = {
  needs_attention: {
    role: 'viewer',
    confirm: false,
    label: 'Checked what needs attention',
    title: 'Needs attention',
    description:
      'What is waiting on people: open approvals (oldest first), orders that failed or rolled back in the last 3 days, and orders waiting on a business event for over a day.',
  },
  find_orders: {
    role: 'viewer',
    confirm: false,
    label: 'Searched orders',
    title: 'Find orders',
    description:
      'Search orders. Totals compare in USD. Returns the count and total of all matches plus up to `limit` rows.',
  },
  get_order: {
    role: 'viewer',
    confirm: false,
    label: 'Read the order',
    title: 'Get an order',
    description:
      'One order: status, what it waits on (with where each decision leads), steps run so far and recent activity.',
  },
  assess_order: {
    role: 'viewer',
    confirm: false,
    label: 'Assessed the order',
    title: 'Assess an order',
    description:
      'Ask typed questions about one order and get a probability for every option: noul (yes/no, the probability of yes), choice (pick one of 2–255 options) or score (an ordered rubric of 2–10 levels, lowest first). Optionally pass up to 4 images (the order’s R2 document keys, https or data URLs; PNG, JPEG or WebP).',
  },
  find_products: {
    role: 'viewer',
    confirm: false,
    label: 'Looked up stock',
    title: 'Find products',
    description: 'Products with stock, reserved and available quantities and reorder points.',
  },
  list_flows: {
    role: 'viewer',
    confirm: false,
    label: 'Listed flows',
    title: 'List flows',
    description: 'All flows and their published versions.',
  },
  get_flow: {
    role: 'viewer',
    confirm: false,
    label: 'Read the flow',
    title: 'Get a flow',
    description: 'A flow’s saved draft: its steps, connections and validation problems.',
  },
  propose_flow_change: {
    role: 'operator',
    confirm: false,
    label: 'Drafted a flow change',
    title: 'Propose a flow change',
    description:
      'Draft a change to a flow from an instruction. Nothing is saved: a person reviews the proposal in the flow editor and applies it there.',
  },
  decide_approval: {
    role: 'approver',
    confirm: true,
    label: 'Decide an approval',
    title: 'Decide an approval',
    description: 'Approve or reject an approval an order is waiting on.',
  },
  deliver_event: {
    role: 'operator',
    confirm: true,
    label: 'Deliver an event',
    title: 'Deliver an event',
    description: 'Deliver a business event (e.g. payment.received) to the order waiting for it.',
  },
  cancel_order: {
    role: 'operator',
    confirm: true,
    label: 'Cancel an order',
    title: 'Cancel an order',
    description:
      'Cancel an order and undo what it did (release stock, void payment, cancel shipments).',
  },
  publish_flow: {
    role: 'operator',
    confirm: true,
    label: 'Publish a flow',
    title: 'Publish a flow',
    description: 'Publish a flow’s saved draft as a new version.',
  },
  run_stock_review: {
    role: 'operator',
    confirm: true,
    label: 'Run the stock review',
    title: 'Run the stock review',
    description:
      'Run the daily stock review now; it starts reorders for SKUs at or below their reorder point.',
  },
};

export const isAssistantTool = (name: string): name is AssistantTool => name in ASSISTANT_TOOLS;

/**
 * An action resolved against live data, shown before a person confirms it: what it is, what will
 * happen, and, when it can't go ahead, why.
 */
export type ActionPreview = {
  title: string;
  consequences: string[];
  /** Set when the action can't run as asked (already decided, wrong role, nothing to publish). */
  blocked?: string;
  /** Where to look, e.g. `/orders/ord_…`. */
  href?: string;
};

/** What `propose_flow_change` returns: a whole graph to review in the editor, never saved. */
export type FlowProposal = {
  flowId: string;
  flowName: string;
  explanation: string;
  graph: FlowGraph;
  errors: GraphIssue[];
  warnings: GraphIssue[];
  /** Counted against the graph it started from. */
  changes: { added: number; removed: number; edited: number; rewired: number };
};

/** What changed between two graphs, ignoring layout. */
export function graphDiff(before: FlowGraph, after: FlowGraph): FlowProposal['changes'] {
  const strip = (n: FlowGraph['nodes'][number]) => JSON.stringify({ ...n, position: null });
  const b = new Map(before.nodes.map((n) => [n.id, strip(n)]));
  const a = new Map(after.nodes.map((n) => [n.id, strip(n)]));
  const eb = new Set(before.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
  const ea = new Set(after.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
  return {
    added: [...a.keys()].filter((id) => !b.has(id)).length,
    removed: [...b.keys()].filter((id) => !a.has(id)).length,
    edited: [...a].filter(([id, v]) => b.has(id) && b.get(id) !== v).length,
    rewired: [...ea].filter((k) => !eb.has(k)).length + [...eb].filter((k) => !ea.has(k)).length,
  };
}

/** "2 steps added, 1 edited", or null when nothing but layout changed. */
export function describeDiff(c: FlowProposal['changes']): string | null {
  const parts = [
    c.added ? `${c.added} step${c.added === 1 ? '' : 's'} added` : '',
    c.removed ? `${c.removed} removed` : '',
    c.edited ? `${c.edited} edited` : '',
    c.rewired ? `${c.rewired} connection${c.rewired === 1 ? '' : 's'} changed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
