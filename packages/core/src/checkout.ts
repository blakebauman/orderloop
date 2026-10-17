/**
 * Agentic checkout, independent of the protocol that carries it (UCP today, see ./ucp/): a
 * session a buying agent builds up (lines, buyer, ship-to, shipping option), priced by the
 * checkout flow's own pricing nodes, then completed into an order of that flow. Pure: the engine
 * stores sessions in D1 and runs the quote (apps/engine/src/ucp/).
 *
 * A session's status follows from what it holds: anything the buyer must still supply, or an
 * error the agent can fix, keeps it `incomplete`; an error only a person can clear makes it
 * `requires_escalation`; otherwise it is `ready_for_complete`. Completing moves it through
 * `complete_in_progress` to `completed`, and from then on it never changes.
 */

import type { ShipAddress } from './address';
import { isBackEdge } from './graph';
import type { ShippingOption } from './shipping';
import type { FlowGraph, FlowNode, FulfillmentMethod } from './types';

export const CHECKOUT_STATUSES = [
  'incomplete',
  'requires_escalation',
  'ready_for_complete',
  'complete_in_progress',
  'completed',
  'canceled',
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** Statuses a session never leaves. */
export const FINAL_CHECKOUT_STATUSES: readonly CheckoutStatus[] = ['completed', 'canceled'];

/** How long a session lives when nothing says otherwise. */
export const CHECKOUT_TTL_MS = 6 * 3_600_000;

/** Lines per session, and units per line. */
export const MAX_CHECKOUT_LINES = 100;
export const MAX_LINE_QUANTITY = 10_000;

/**
 * What can be wrong with a session, as the protocol layer reports it:
 *
 * - `recoverable`: the agent can fix it by changing the session (an unknown SKU, a missing email).
 * - `requires_buyer_input`: the buyer must supply something no API field carries.
 * - `requires_buyer_review`: the buyer must approve something before the order is placed.
 * - `unrecoverable`: nothing can be done with this session; start a new one.
 */
export const ISSUE_SEVERITIES = [
  'recoverable',
  'requires_buyer_input',
  'requires_buyer_review',
  'unrecoverable',
] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export type CheckoutIssue = {
  kind: 'error' | 'warning' | 'info';
  code: string;
  content: string;
  /** JSONPath into the session as the protocol shows it, e.g. `$.line_items[0]`. */
  path?: string;
  /** Errors only. */
  severity?: IssueSeverity;
};

export type CheckoutLine = {
  /** Stable within the session, so an agent can name the line it changes. */
  id: string;
  sku: string;
  qty: number;
  /** Set by the quote. */
  title?: string;
  unitPrice?: number;
};

export type CheckoutBuyer = {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
};

/** The price of a session, as the checkout flow's pricing nodes worked it out. */
export type CheckoutQuote = {
  currency: string;
  lines: {
    id: string;
    sku: string;
    title: string;
    qty: number;
    unitPrice: number;
    /** A physical good: it needs a ship-to. */
    ships: boolean;
  }[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  /** Shipping options on offer for the ship-to; empty when nothing ships. */
  shippingOptions: ShippingOption[];
  /** The option the quote charged, if any. */
  shippingOption: string | null;
  /** Whether any line ships (a physical good). */
  ships: boolean;
};

export type CheckoutSession = {
  id: string;
  /** Who opened it: the protocol's caller (a UCP platform). */
  ownerId: string;
  status: CheckoutStatus;
  currency: string;
  lines: CheckoutLine[];
  buyer: CheckoutBuyer;
  fulfillment: FulfillmentMethod;
  shipTo: Partial<ShipAddress> | null;
  shippingOption: string | null;
  quote: CheckoutQuote | null;
  issues: CheckoutIssue[];
  /** The order completing it started. */
  orderId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Bumped on every write; writes compare it, so two never interleave. */
  version: number;
};

/** What a buying agent may change. Lines replace the session's lines when given. */
export type CheckoutPatch = {
  lines?: { id?: string; sku: string; qty: number }[];
  buyer?: CheckoutBuyer;
  shipTo?: Partial<ShipAddress> | null;
  shippingOption?: string | null;
};

export const isFinalCheckout = (s: Pick<CheckoutSession, 'status'>) =>
  FINAL_CHECKOUT_STATUSES.includes(s.status);

/** Whether the session may still be changed: not final, and not being completed. */
export const isOpenCheckout = (s: Pick<CheckoutSession, 'status'>) =>
  !isFinalCheckout(s) && s.status !== 'complete_in_progress';

export const isExpired = (s: Pick<CheckoutSession, 'expiresAt' | 'status'>, now: number) =>
  isOpenCheckout(s) && s.expiresAt <= now;

/** A new session's lines get ids `li_1`, `li_2`, …; a line keeps its id across updates. */
export function applyLines(
  current: CheckoutLine[],
  next: NonNullable<CheckoutPatch['lines']>,
): CheckoutLine[] {
  const known = new Map(current.map((l) => [l.id, l]));
  let n = current.reduce((m, l) => Math.max(m, Number(l.id.replace(/^li_/, '')) || 0), 0);
  return next.map((l) => {
    const kept = l.id ? known.get(l.id) : undefined;
    return kept ? { ...kept, sku: l.sku, qty: l.qty } : { id: `li_${++n}`, sku: l.sku, qty: l.qty };
  });
}

/** The session with `patch` applied; pricing and status are the caller's next step. */
export function patchCheckout(s: CheckoutSession, patch: CheckoutPatch): CheckoutSession {
  return {
    ...s,
    lines: patch.lines ? applyLines(s.lines, patch.lines) : s.lines,
    buyer: patch.buyer ? { ...patch.buyer } : s.buyer,
    shipTo: patch.shipTo !== undefined ? patch.shipTo : s.shipTo,
    shippingOption: patch.shippingOption !== undefined ? patch.shippingOption : s.shippingOption,
  };
}

const ADDRESS_FIELDS = ['line1', 'city', 'postalCode', 'country'] as const;

/**
 * What the session still lacks before it can be completed, as recoverable errors: lines, an email
 * to send the confirmation to, and for anything that ships a full address and an option (the
 * flow's shipping node picks one, the cheapest unless it says otherwise, when the agent doesn't).
 * The quote's own problems come on top.
 */
export function missingInfo(s: CheckoutSession): CheckoutIssue[] {
  const out: CheckoutIssue[] = [];
  const missing = (path: string, content: string): CheckoutIssue => ({
    kind: 'error',
    code: 'missing',
    path,
    content,
    severity: 'recoverable',
  });
  if (!s.lines.length) out.push(missing('$.line_items', 'Add at least one line item.'));
  if (!s.buyer.email) out.push(missing('$.buyer.email', "The buyer's email is required."));
  const q = s.quote;
  if (q?.ships) {
    for (const f of ADDRESS_FIELDS)
      if (!s.shipTo?.[f]) {
        out.push(missing('$.fulfillment', 'A complete shipping address is required.'));
        break;
      }
    if (q.shippingOptions.length && !s.shippingOption && !q.shippingOption)
      out.push(missing('$.fulfillment', 'Choose a shipping option.'));
  }
  return out;
}

/** The status a session in an open state should have, from its issues. */
export function openStatus(issues: CheckoutIssue[]): CheckoutStatus {
  const errors = issues.filter((i) => i.kind === 'error');
  if (
    errors.some(
      (i) => i.severity === 'requires_buyer_input' || i.severity === 'requires_buyer_review',
    )
  )
    return 'requires_escalation';
  return errors.length ? 'incomplete' : 'ready_for_complete';
}

/**
 * Node types the checkout runs, in graph order, to price a session exactly as the flow will, and
 * to tell the agent up front when the flow's store policy would refuse it.
 */
export const QUOTE_NODE_TYPES = [
  'commerce.validate',
  'commerce.price',
  'commerce.shipping_rate',
  'commerce.tax',
  'commerce.policy',
] as const;

/**
 * The flow's pricing nodes (`QUOTE_NODE_TYPES`) in the order the flow reaches them: a topological
 * order of the graph without loop back-edges, ties in node order. A type that appears twice is
 * priced once, at its first occurrence.
 */
export function quoteNodes(graph: FlowGraph): FlowNode[] {
  const edges = graph.edges.filter((e) => !isBackEdge(e));
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const order: FlowNode[] = [];
  const ready = graph.nodes.filter((n) => !indegree.get(n.id));
  const placed = new Set<string>();
  while (ready.length) {
    const n = ready.shift()!;
    if (placed.has(n.id)) continue;
    placed.add(n.id);
    order.push(n);
    for (const e of edges)
      if (e.source === n.id) {
        const left = (indegree.get(e.target) ?? 0) - 1;
        indegree.set(e.target, left);
        if (left === 0) {
          const t = graph.nodes.find((x) => x.id === e.target);
          if (t) ready.push(t);
        }
      }
    ready.sort((a, b) => graph.nodes.indexOf(a) - graph.nodes.indexOf(b));
  }
  const seen = new Set<string>();
  return order.filter((n) => {
    if (!(QUOTE_NODE_TYPES as readonly string[]).includes(n.type) || seen.has(n.type)) return false;
    seen.add(n.type);
    return true;
  });
}

/** Why a flow can't take checkouts, or null when it can: it must authorize a card. */
export function checkoutFlowProblem(graph: FlowGraph): string | null {
  const authorize = graph.nodes.find((n) => n.type === 'commerce.authorize_payment');
  if (!authorize)
    return 'The checkout flow must authorize the payment (commerce.authorize_payment).';
  const method = authorize.config?.method;
  if (method !== undefined && method !== 'card' && method !== 'wallet')
    return `The checkout flow authorizes "${String(method)}"; checkout pays by card.`;
  if (authorize.config?.purpose === 'verify')
    return 'The checkout flow only verifies the card; it must hold the payment to capture it later.';
  return null;
}
