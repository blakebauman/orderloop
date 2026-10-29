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
  | {
      kind: 'order';
      id: string;
      label: string;
      /** Whether it waits on an approval, so the panel only suggests asking about one then. */
      awaitingApproval?: boolean;
    }
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
  | 'list_carts'
  | 'get_cart'
  | 'list_flows'
  | 'get_flow'
  | 'propose_flow_change'
  | 'draft_plugin'
  | 'draft_product_content'
  | 'create_cart'
  | 'change_cart'
  | 'decide_approval'
  | 'decide_approvals'
  | 'deliver_event'
  | 'cancel_order'
  | 'submit_cart'
  | 'publish_flow'
  | 'run_stock_review'
  | 'start_order'
  | 'restart_order'
  | 'start_scenario'
  | 'cancel_cart'
  | 'save_flow_draft'
  | 'create_flow'
  | 'duplicate_flow'
  | 'archive_flow'
  | 'test_flow'
  | 'stage_product_edits'
  | 'accept_product_drafts'
  | 'discard_product_edits'
  | 'publish_catalog'
  | 'create_promotion'
  | 'set_promotion_status'
  | 'verify_tax_certificate'
  | 'revoke_tax_certificate';

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
  list_carts: {
    role: 'viewer',
    confirm: false,
    label: 'Listed carts',
    title: 'List carts',
    description:
      'Carts people are building before they become orders, most recently changed first: title, status, customer and, once submitted, its order.',
  },
  get_cart: {
    role: 'viewer',
    confirm: false,
    label: 'Read the cart',
    title: 'Get a cart',
    description:
      'One cart: its lines (with each line’s id) at the prices its flow quoted, promo codes, problems the quote found, and why it can’t be submitted yet.',
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
  draft_plugin: {
    role: 'admin',
    confirm: false,
    label: 'Drafted a plugin',
    title: 'Draft a business-rule plugin',
    description:
      'Draft a plugin of business-rule flow steps from an instruction (e.g. “hold orders over $5,000 shipping outside the US”), with test cases. Nothing runs: an admin reviews it on the Plugins page, runs its cases and approves it there. Give pluginId to revise a drafted plugin.',
  },
  draft_product_content: {
    role: 'operator',
    confirm: false,
    label: 'Drafted product content',
    title: 'Draft product content',
    description:
      'Draft a catalog product’s missing text (titles, descriptions, text attributes and image alt text, locale by locale) from what it says in its other locales. Name fields and locales to draft those instead. The drafts are saved on the product; nothing goes live until a person accepts and publishes them.',
  },
  create_cart: {
    role: 'operator',
    confirm: false,
    label: 'Opened a cart',
    title: 'Open a cart',
    description:
      'Open a cart priced by a published flow that prices orders, for a customer if given. Nothing is ordered until the cart is submitted.',
  },
  change_cart: {
    role: 'operator',
    confirm: false,
    label: 'Changed the cart',
    title: 'Change a cart',
    description:
      'Change an open cart, op by op in order: add a SKU, set a line’s quantity (0 removes it), set several lines’ quantities in one change (set_qtys, all or none), remove lines, clear it, add or remove a promo code, set or clear the ship-to address, choose a shipping option from the quote, lock, unlock or rename it. The cart’s flow prices it again; nothing is ordered.',
  },
  decide_approval: {
    role: 'approver',
    confirm: true,
    label: 'Decide an approval',
    title: 'Decide an approval',
    description: 'Approve or reject an approval an order is waiting on.',
  },
  decide_approvals: {
    role: 'approver',
    confirm: true,
    label: 'Decide approvals',
    title: 'Decide several approvals',
    description:
      'Approve or reject up to 25 open approvals at once, with one note for all. Each is checked and decided on its own; one that can’t be decided is skipped and says why.',
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
  submit_cart: {
    role: 'operator',
    confirm: true,
    label: 'Submit a cart',
    title: 'Submit a cart',
    description:
      'Submit a priced cart as an order of its flow, with its lines, customer and promo codes. The order is priced again by its flow when it runs, as any order is. The cart ends.',
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
  start_order: {
    role: 'operator',
    confirm: true,
    label: 'Start an order',
    title: 'Start an order',
    description:
      'Start a new order on a published flow: its lines (SKU and quantity), and optionally a customer or a guest contact, fulfilment (pickup and carry-out need a store), currency, title and document text for the flow to read. It runs the flow for real.',
  },
  restart_order: {
    role: 'operator',
    confirm: true,
    label: 'Restart an order',
    title: 'Restart an order',
    description:
      'Start a fresh order like an existing one: same customer, lines and fulfilment, on its flow’s current version. The old order stays as it is.',
  },
  start_scenario: {
    role: 'operator',
    // Fixed demo data, only where it is loaded, and only from its button (`PAGE_ONLY_TOOLS`).
    confirm: false,
    label: 'Run a demo scenario',
    title: 'Run a demo scenario',
    description:
      'Start one of the workspace’s demo scenario orders by its id. Only where the demo data is loaded.',
  },
  cancel_cart: {
    role: 'operator',
    confirm: true,
    label: 'Cancel a cart',
    title: 'Cancel a cart',
    description: 'Cancel an open or locked cart. Nothing is ordered, and the cart ends.',
  },
  save_flow_draft: {
    role: 'operator',
    // The editor's Save, and only it (`PAGE_ONLY_TOOLS`): it overwrites the draft.
    confirm: false,
    label: 'Saved the draft',
    title: 'Save a flow draft',
    description: 'Save a flow’s draft as the editor shows it. Nothing runs until it is published.',
  },
  create_flow: {
    role: 'operator',
    confirm: false,
    label: 'Created a flow',
    title: 'Create a flow',
    description:
      'Create a new, unpublished flow for a commerce model: from its template, a blank start, or drafted from a description of the steps. Nothing runs until it is published.',
  },
  duplicate_flow: {
    role: 'operator',
    confirm: false,
    label: 'Duplicated a flow',
    title: 'Duplicate a flow',
    description: 'Copy a flow’s current draft as a new, unpublished flow.',
  },
  archive_flow: {
    role: 'operator',
    confirm: false,
    label: 'Archived a flow',
    title: 'Archive or restore a flow',
    description:
      'Archive (or restore) a draft that was never published, so it leaves the flows list. Published flows can’t be archived.',
  },
  test_flow: {
    role: 'operator',
    confirm: true,
    label: 'Test a flow',
    title: 'Test a flow',
    description:
      'Run a test order on a flow: publishes its saved draft first when it changed since the live version, then starts an order with a demo input where the demo data is loaded.',
  },
  // The Catalog page's own buttons (`PAGE_ONLY_TOOLS`): each overwrites or drops what waits to
  // publish. A model drafts instead (`draft_product_content`), and a person accepts.
  stage_product_edits: {
    role: 'operator',
    confirm: false,
    label: 'Staged catalog edits',
    title: 'Stage product edits',
    description: 'Stage edits to products’ fields; nothing is live until published.',
  },
  accept_product_drafts: {
    role: 'operator',
    confirm: false,
    label: 'Accepted the drafts',
    title: 'Accept a product’s drafts',
    description: 'Stage the assistant’s drafts for a product, as the assistant’s text.',
  },
  discard_product_edits: {
    role: 'operator',
    confirm: false,
    label: 'Discarded catalog edits',
    title: 'Discard staged edits or drafts',
    description: 'Drop staged edits or the assistant’s drafts, for one field or a whole product.',
  },
  publish_catalog: {
    role: 'operator',
    confirm: true,
    label: 'Publish catalog edits',
    title: 'Publish catalog edits',
    description:
      'Publish the staged edits of up to 500 products to the live catalog, each product all or none.',
  },
  create_promotion: {
    role: 'operator',
    confirm: true,
    label: 'Add a promotion',
    title: 'Add a promotion code',
    description:
      'Add a promotion code buyers and staff enter on carts and at checkout: a percentage or amount off, or free shipping, optionally limited by subtotal, SKUs, customer, end date and uses. Active at once.',
  },
  set_promotion_status: {
    role: 'operator',
    confirm: true,
    label: 'Pause or reactivate a promotion',
    title: 'Pause or reactivate a promotion',
    description: 'Pause a promotion code so carts stop accepting it, or reactivate it.',
  },
  verify_tax_certificate: {
    role: 'operator',
    confirm: true,
    label: 'Verify a tax certificate',
    title: 'Verify a tax exemption certificate',
    description:
      'Verify a customer’s tax exemption certificate, so orders they start from now are exempt in its regions. With approval separation on, whoever added it can’t verify it.',
  },
  revoke_tax_certificate: {
    role: 'operator',
    confirm: true,
    label: 'Revoke a tax certificate',
    title: 'Revoke a tax exemption certificate',
    description:
      'Revoke a customer’s tax exemption certificate, so their new orders are taxed again.',
  },
};

/**
 * The id prefix of a tool call a page made through the assistant (`act`), with no model: the panel
 * answers its confirm card with `resolve`, not as a model's approval.
 */
export const DIRECT_CALL = 'direct_';

export const isAssistantTool = (name: string): name is AssistantTool => name in ASSISTANT_TOOLS;

/**
 * Tools that save something without a confirm: nothing they save runs until someone approves it
 * (a plugin draft), publishes it (a product draft) or submits it (a cart).
 */
export const WRITES_WITHOUT_CONFIRM: readonly AssistantTool[] = [
  'draft_plugin',
  'draft_product_content',
  'create_cart',
  'change_cart',
  'start_scenario',
  'create_flow',
  'duplicate_flow',
  'archive_flow',
  'stage_product_edits',
  'accept_product_drafts',
  'discard_product_edits',
];

/**
 * Tools only a page's own button calls (`act`): never offered to the model, MCP or A2A. A demo
 * scenario starts a real order at one press; that press is the person's own, so nothing else may
 * make it without a confirm.
 */
export const PAGE_ONLY_TOOLS: readonly AssistantTool[] = [
  'start_scenario',
  'save_flow_draft',
  'stage_product_edits',
  'accept_product_drafts',
  'discard_product_edits',
];

export const isPageOnly = (name: AssistantTool) => PAGE_ONLY_TOOLS.includes(name);

/**
 * Actions that change what buyers pay or owe in tax: a person always confirms them on a card (the
 * panel, MCP's confirmation, A2A chat's `{ confirm: true }`), never a typed A2A skill that runs
 * as composed.
 */
export const PERSON_CONFIRMS_TOOLS: readonly AssistantTool[] = [
  'create_promotion',
  'set_promotion_status',
  'verify_tax_certificate',
  'revoke_tax_certificate',
];

/** Whether a tool changes anything: an action, or a write that needs no confirm. */
export const isWriteTool = (name: AssistantTool) =>
  ASSISTANT_TOOLS[name].confirm || WRITES_WITHOUT_CONFIRM.includes(name);

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
  /**
   * What confirming this preview is held to besides the input: what the person saw that can
   * change before they confirm (a cart's `cartVersion`). The server that showed the preview keeps
   * its own copy and hands it to the action, which refuses when it no longer holds.
   */
  bound?: Record<string, unknown>;
};

/** What `draft_plugin` returns: a pending draft to review on the Plugins page, never running. */
export type PluginDraftResult = {
  id: string;
  sha: string;
  name: string;
  version: string;
  explanation: string;
  /** The flow steps it adds: type and label. */
  nodes: { type: string; label: string }[];
  cases: { total: number; passed: number };
  /** Where to review and approve it. */
  href: string;
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
