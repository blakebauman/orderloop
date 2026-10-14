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
 */
export const ASSISTANT_TOOLS: Record<
  AssistantTool,
  { role: Role; confirm: boolean; label: string }
> = {
  needs_attention: { role: 'viewer', confirm: false, label: 'Checked what needs attention' },
  find_orders: { role: 'viewer', confirm: false, label: 'Searched orders' },
  get_order: { role: 'viewer', confirm: false, label: 'Read the order' },
  find_products: { role: 'viewer', confirm: false, label: 'Looked up stock' },
  list_flows: { role: 'viewer', confirm: false, label: 'Listed flows' },
  get_flow: { role: 'viewer', confirm: false, label: 'Read the flow' },
  propose_flow_change: { role: 'operator', confirm: false, label: 'Drafted a flow change' },
  decide_approval: { role: 'approver', confirm: true, label: 'Decide an approval' },
  deliver_event: { role: 'operator', confirm: true, label: 'Deliver an event' },
  cancel_order: { role: 'operator', confirm: true, label: 'Cancel an order' },
  publish_flow: { role: 'operator', confirm: true, label: 'Publish a flow' },
  run_stock_review: { role: 'operator', confirm: true, label: 'Run the stock review' },
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
