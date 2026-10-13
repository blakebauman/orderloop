/**
 * The node catalog: every node type's metadata, its config fields and its output branches.
 * The editor builds its palette and inspector forms from this; the engine pairs each type with an
 * executor (apps/engine/src/nodes). Config fields are the single source of truth for validation.
 */

import { z } from 'zod';
import { policyRulesSchema } from './policy';

export type NodeCategory = 'trigger' | 'commerce' | 'control' | 'ai';

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: 'Triggers',
  commerce: 'Commerce',
  control: 'Control',
  ai: 'AI',
};

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'duration'
  /** A JSON Logic expression evaluated against the run context. */
  | 'logic'
  | 'json'
  | 'list';

export type ConfigField = {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
  /** Overrides the kind's validation, for structured `json` fields. */
  schema?: z.ZodType;
};

export type NodeSpec = {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  fields: ConfigField[];
  /** Output branches. A function when they depend on config (the AI router's routes). */
  outputs: string[] | ((config: Record<string, unknown>) => string[]);
  /** Has a saga compensation registered on its step (released on failure). */
  rollback?: boolean;
  /** Waits for a human or an external event. */
  waits?: boolean;
  /** `control.loop` only: has the extra "next" input for back-edges. */
  loop?: boolean;
  retries?: number;
};

const OUT = ['out'];

const node = (spec: NodeSpec) => spec;

export const NODE_SPECS = [
  // ── Triggers ────────────────────────────────────────────────────────────────
  node({
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Manual / API',
    description: 'Started from the dashboard or POST /api/v1/orders.',
    icon: 'Play',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'trigger.webhook',
    category: 'trigger',
    label: 'Webhook',
    description: 'Started by an inbound webhook (storefront checkout, marketplace order).',
    icon: 'Webhook',
    fields: [{ key: 'source', label: 'Source', kind: 'text', default: 'storefront' }],
    outputs: OUT,
  }),
  node({
    type: 'trigger.email_po',
    category: 'trigger',
    label: 'Inbound PO email',
    description: 'A purchase order arrives by email or upload; the document is stored in R2.',
    icon: 'Mail',
    fields: [{ key: 'mailbox', label: 'Mailbox', kind: 'text', default: 'orders@' }],
    outputs: OUT,
  }),
  node({
    type: 'trigger.schedule',
    category: 'trigger',
    label: 'Schedule',
    description: 'Started on a cadence (reorder runs, subscription renewals).',
    icon: 'CalendarClock',
    fields: [{ key: 'cron', label: 'Cron', kind: 'text', default: '0 6 * * *' }],
    outputs: OUT,
  }),
  node({
    type: 'trigger.inventory_threshold',
    category: 'trigger',
    label: 'Inventory threshold',
    description: 'Started when a SKU falls below its reorder point.',
    icon: 'PackageMinus',
    fields: [],
    outputs: OUT,
  }),

  // ── Commerce ────────────────────────────────────────────────────────────────
  node({
    type: 'commerce.validate',
    category: 'commerce',
    label: 'Validate order',
    description: 'Normalises lines, resolves SKUs and the customer, rejects empty orders.',
    icon: 'ListChecks',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'commerce.price',
    category: 'commerce',
    label: 'Price & quote',
    description: 'Applies list or contract pricing and computes the subtotal.',
    icon: 'Tags',
    fields: [
      {
        key: 'useContracts',
        label: 'Contract pricing',
        kind: 'boolean',
        default: true,
        hint: 'Use the customer’s negotiated prices',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.tax',
    category: 'commerce',
    label: 'Calculate tax',
    description: 'Computes tax on the subtotal (mock tax engine).',
    icon: 'Percent',
    fields: [{ key: 'rate', label: 'Rate', kind: 'number', default: 0.08 }],
    outputs: OUT,
  }),
  node({
    type: 'commerce.policy',
    category: 'commerce',
    label: 'Policy check',
    description:
      'Checks order rules: minimum or maximum total, per-SKU limits, business hours, PO boxes, restricted SKUs.',
    icon: 'Scale',
    fields: [
      {
        key: 'rules',
        label: 'Rules',
        kind: 'json',
        required: true,
        schema: policyRulesSchema.min(1),
        default: [
          { rule: 'min_order_amount', amount: 25 },
          { rule: 'max_qty_per_sku', qty: 500 },
        ],
        hint: 'min_order_amount, max_order_amount, max_qty_per_sku, business_hours, no_po_box, restricted_skus',
      },
    ],
    outputs: ['pass', 'fail'],
  }),
  node({
    type: 'commerce.address_validate',
    category: 'commerce',
    label: 'Validate address',
    description:
      'Checks and normalises the ship-to in order.meta.shipTo. A correction is offered in vars.suggestedAddress.',
    icon: 'MapPin',
    fields: [],
    outputs: ['valid', 'corrected', 'invalid'],
  }),
  node({
    type: 'commerce.credit_check',
    category: 'commerce',
    label: 'Credit check',
    description: 'Compares the order total plus open balance with the customer’s credit limit.',
    icon: 'ShieldCheck',
    fields: [],
    outputs: ['ok', 'over_limit'],
  }),
  node({
    type: 'commerce.budget_check',
    category: 'commerce',
    label: 'Budget check',
    description: 'Checks a purchase request against the department budget.',
    icon: 'Wallet',
    fields: [{ key: 'budget', label: 'Budget', kind: 'number', default: 25000 }],
    outputs: ['within', 'over'],
  }),
  node({
    type: 'commerce.reserve_inventory',
    category: 'commerce',
    label: 'Reserve inventory',
    description: 'Holds stock for every line. Released automatically if the order later fails.',
    icon: 'PackageCheck',
    fields: [{ key: 'allowBackorder', label: 'Allow backorder', kind: 'boolean', default: false }],
    outputs: ['ok', 'backorder'],
    rollback: true,
  }),
  node({
    type: 'commerce.authorize_payment',
    category: 'commerce',
    label: 'Authorize payment',
    description: 'Places an authorization hold. Voided automatically if the order later fails.',
    icon: 'CreditCard',
    fields: [
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        options: ['card', 'ach', 'terms'],
        default: 'card',
      },
    ],
    outputs: ['ok', 'declined'],
    rollback: true,
  }),
  node({
    type: 'commerce.capture_payment',
    category: 'commerce',
    label: 'Capture payment',
    description: 'Captures a previous authorization.',
    icon: 'BadgeDollarSign',
    fields: [],
    outputs: ['ok', 'failed'],
  }),
  node({
    type: 'commerce.charge',
    category: 'commerce',
    label: 'Charge',
    description: 'Charges the stored payment method (subscription renewal).',
    icon: 'Repeat',
    fields: [],
    outputs: ['ok', 'failed'],
    retries: 0,
  }),
  node({
    type: 'commerce.refund',
    category: 'commerce',
    label: 'Refund',
    description:
      'Refunds captured or charged money, all of it or an amount computed from the context.',
    icon: 'Undo2',
    fields: [
      {
        key: 'amount',
        label: 'Amount (expression)',
        kind: 'logic',
        hint: 'Empty refunds everything still refundable',
      },
      { key: 'reason', label: 'Reason', kind: 'text', default: 'Customer return' },
    ],
    outputs: ['ok', 'failed'],
  }),
  node({
    type: 'commerce.invoice',
    category: 'commerce',
    label: 'Generate invoice',
    description: 'Renders the invoice to R2 with the configured payment terms.',
    icon: 'FileText',
    fields: [
      {
        key: 'terms',
        label: 'Terms',
        kind: 'select',
        options: ['due_on_receipt', 'net_15', 'net_30', 'net_60'],
        default: 'net_30',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.generate_po',
    category: 'commerce',
    label: 'Generate PO',
    description: 'Renders a purchase order for the supplier to R2.',
    icon: 'FilePlus2',
    fields: [{ key: 'supplier', label: 'Supplier', kind: 'text', default: '{{vars.supplier}}' }],
    outputs: OUT,
  }),
  node({
    type: 'commerce.ship',
    category: 'commerce',
    label: 'Create shipment',
    description: 'Buys a label and books the carrier. Cancelled automatically if the order fails.',
    icon: 'Truck',
    fields: [
      {
        key: 'carrier',
        label: 'Carrier',
        kind: 'select',
        options: ['ups', 'fedex', 'dhl', 'freight'],
        default: 'ups',
      },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.return_label',
    category: 'commerce',
    label: 'Return label',
    description: 'Issues a prepaid return label (an RMA) and sends it to the customer.',
    icon: 'PackageOpen',
    fields: [
      {
        key: 'carrier',
        label: 'Carrier',
        kind: 'select',
        options: ['ups', 'fedex', 'dhl', 'freight'],
        default: 'ups',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.three_way_match',
    category: 'commerce',
    label: '3-way match',
    description: 'Matches the PO, the goods receipt and the supplier invoice.',
    icon: 'GitCompareArrows',
    fields: [{ key: 'tolerance', label: 'Tolerance', kind: 'number', default: 0.02 }],
    outputs: ['match', 'mismatch'],
  }),
  node({
    type: 'commerce.pay_supplier',
    category: 'commerce',
    label: 'Pay supplier',
    description: 'Schedules the supplier payment.',
    icon: 'Landmark',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'commerce.restock',
    category: 'commerce',
    label: 'Restock',
    description: 'Adds received or returned quantities to on-hand inventory.',
    icon: 'Warehouse',
    fields: [
      {
        key: 'lines',
        label: 'Lines (expression)',
        kind: 'logic',
        hint: 'A list of { sku, qty }; empty restocks every order line. Capped at the ordered quantity.',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.erp_sync',
    category: 'commerce',
    label: 'ERP sync',
    description: 'Posts the order to the ERP (mock).',
    icon: 'DatabaseZap',
    fields: [{ key: 'system', label: 'System', kind: 'text', default: 'netsuite' }],
    outputs: OUT,
  }),
  node({
    type: 'commerce.notify',
    category: 'commerce',
    label: 'Notify',
    description: 'Sends a message to the customer, a supplier or the team.',
    icon: 'Send',
    fields: [
      {
        key: 'to',
        label: 'To',
        kind: 'select',
        options: ['customer', 'supplier', 'team'],
        default: 'customer',
      },
      { key: 'subject', label: 'Subject', kind: 'text', default: 'Order {{order.id}} update' },
      { key: 'body', label: 'Body', kind: 'textarea', default: '' },
    ],
    outputs: OUT,
  }),

  // ── Control ────────────────────────────────────────────────────────────────
  node({
    type: 'control.condition',
    category: 'control',
    label: 'Condition',
    description: 'Branches on a JSON Logic expression over the run context.',
    icon: 'Split',
    fields: [
      {
        key: 'expression',
        label: 'Expression',
        kind: 'logic',
        required: true,
        default: { '>': [{ var: 'order.total' }, 1000] },
      },
    ],
    outputs: ['true', 'false'],
  }),
  node({
    type: 'control.approval',
    category: 'control',
    label: 'Approval',
    description: 'Waits for a person to approve or reject. Escalates when the timeout passes.',
    icon: 'UserCheck',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', default: 'Approve order {{order.id}}' },
      { key: 'assignee', label: 'Assignee', kind: 'text', default: 'manager' },
      { key: 'timeout', label: 'Escalate after', kind: 'duration', default: '2 days' },
    ],
    outputs: ['approved', 'rejected', 'escalated'],
    waits: true,
  }),
  node({
    type: 'control.wait_event',
    category: 'control',
    label: 'Wait for event',
    description: 'Waits for an external event (payment received, supplier ack, goods received).',
    icon: 'Hourglass',
    fields: [
      { key: 'event', label: 'Event', kind: 'text', required: true, default: 'payment.received' },
      { key: 'timeout', label: 'Timeout', kind: 'duration', default: '30 days' },
    ],
    outputs: ['received', 'timeout'],
    waits: true,
  }),
  node({
    type: 'control.wait',
    category: 'control',
    label: 'Wait',
    description: 'Sleeps for a duration, or until a timestamp computed from the context.',
    icon: 'Timer',
    fields: [
      { key: 'duration', label: 'Duration', kind: 'duration', default: '1 day' },
      {
        key: 'until',
        label: 'Until (expression)',
        kind: 'logic',
        hint: 'Epoch ms; overrides duration',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'control.set',
    category: 'control',
    label: 'Set variables',
    description: 'Assigns run variables from JSON Logic expressions.',
    icon: 'Variable',
    fields: [
      {
        key: 'assign',
        label: 'Assignments',
        kind: 'json',
        default: { cycle: { '+': [{ var: 'vars.cycle' }, 1] } },
        hint: '{ name: expression }',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'control.loop',
    category: 'control',
    label: 'Loop',
    description:
      'Repeats its body while the condition holds, up to a limit. Connect the end of the body back to the “next” input.',
    icon: 'IterationCw',
    fields: [
      { key: 'while', label: 'While', kind: 'logic', default: true },
      { key: 'maxIterations', label: 'Max iterations', kind: 'number', default: 12 },
    ],
    outputs: ['body', 'done'],
    loop: true,
  }),
  node({
    type: 'control.continue_as_new',
    category: 'control',
    label: 'Continue as new',
    description:
      'Ends this run and starts a fresh one on the same flow, carrying the variables forward.',
    icon: 'RotateCw',
    fields: [],
    outputs: [],
  }),
  node({
    type: 'control.end',
    category: 'control',
    label: 'End',
    description:
      'Finishes the order. “declined” is a policy or approval no; “failed” rolls back every compensable step.',
    icon: 'CircleStop',
    fields: [
      {
        key: 'outcome',
        label: 'Outcome',
        kind: 'select',
        options: ['completed', 'declined', 'cancelled', 'failed'],
        default: 'completed',
      },
      { key: 'reason', label: 'Reason', kind: 'text', default: '' },
    ],
    outputs: [],
  }),

  // ── AI ─────────────────────────────────────────────────────────────────────
  node({
    type: 'ai.extract',
    category: 'ai',
    label: 'Extract order',
    description: 'Reads an email or PO document and extracts the customer and line items.',
    icon: 'ScanText',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'ai.classify',
    category: 'ai',
    label: 'Classify',
    description: 'Assigns one label from a list (spend category, urgency, intent).',
    icon: 'Shapes',
    fields: [
      {
        key: 'labels',
        label: 'Labels',
        kind: 'list',
        default: ['it_hardware', 'software', 'office_supplies', 'services', 'travel'],
      },
      { key: 'into', label: 'Store as var', kind: 'text', default: 'category' },
    ],
    outputs: OUT,
  }),
  node({
    type: 'ai.risk_score',
    category: 'ai',
    label: 'Risk score',
    description: 'Scores fraud and credit risk from 0 to 100; branches above the threshold.',
    icon: 'ShieldAlert',
    fields: [{ key: 'threshold', label: 'High risk at', kind: 'number', default: 70 }],
    outputs: ['low', 'high'],
  }),
  node({
    type: 'ai.forecast',
    category: 'ai',
    label: 'Demand forecast',
    description: 'Suggests reorder quantities for SKUs at or below their reorder point.',
    icon: 'TrendingUp',
    fields: [{ key: 'horizonDays', label: 'Horizon (days)', kind: 'number', default: 30 }],
    outputs: OUT,
  }),
  node({
    type: 'ai.summarize',
    category: 'ai',
    label: 'Summarize',
    description: 'Writes a short summary of the order so far into a variable.',
    icon: 'NotebookPen',
    fields: [{ key: 'into', label: 'Store as var', kind: 'text', default: 'summary' }],
    outputs: OUT,
  }),
  node({
    type: 'ai.router',
    category: 'ai',
    label: 'Agent router',
    description:
      'An LLM reads the order and context, then chooses exactly one route. Each route is an output.',
    icon: 'Bot',
    fields: [
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        default: 'Decide how to handle this order.',
      },
      {
        key: 'routes',
        label: 'Routes',
        kind: 'list',
        default: ['auto_approve', 'needs_approval', 'ask_customer'],
      },
    ],
    outputs: (config) => stringList(config.routes, ['auto_approve', 'needs_approval']),
  }),
] as const satisfies readonly NodeSpec[];

export type NodeType = (typeof NODE_SPECS)[number]['type'];

const BY_TYPE = new Map<string, NodeSpec>(NODE_SPECS.map((s) => [s.type, s]));

export function nodeSpec(type: string): NodeSpec | undefined {
  return BY_TYPE.get(type);
}

export function nodeOutputs(type: string, config: Record<string, unknown> = {}): string[] {
  const spec = BY_TYPE.get(type);
  if (!spec) return [];
  return typeof spec.outputs === 'function' ? spec.outputs(config) : spec.outputs;
}

/** Config with every missing field filled from its default. */
export function withDefaults(type: string, config: Record<string, unknown> = {}) {
  const spec = BY_TYPE.get(type);
  const out: Record<string, unknown> = {};
  for (const f of spec?.fields ?? []) {
    if (f.default !== undefined) out[f.key] = structuredClone(f.default);
  }
  return { ...out, ...config };
}

function fieldSchema(f: ConfigField): z.ZodType {
  if (f.schema) return f.schema;
  switch (f.kind) {
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum((f.options ?? []) as [string, ...string[]]);
    case 'duration':
      return z.string().regex(DURATION_RE, 'Use e.g. "30 seconds", "2 days"');
    case 'list':
      return z.array(z.string().min(1)).min(1);
    case 'logic':
    case 'json':
      return z.unknown();
    default:
      return z.string();
  }
}

/** Validates one node's config against its catalog fields. Returns error messages. */
export function validateConfig(type: string, config: Record<string, unknown>): string[] {
  const spec = BY_TYPE.get(type);
  if (!spec) return [`Unknown node type “${type}”`];
  const errors: string[] = [];
  const merged = withDefaults(type, config);
  for (const f of spec.fields) {
    const v = merged[f.key];
    if (v === undefined || v === '') {
      if (f.required) errors.push(`${f.label} is required`);
      continue;
    }
    const r = fieldSchema(f).safeParse(v);
    if (!r.success) errors.push(`${f.label}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  }
  return errors;
}

export const DURATION_RE = /^\s*(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*$/i;

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** "2 days" → 172800000. Throws on anything else. */
export function durationMs(d: string): number {
  const m = DURATION_RE.exec(d);
  if (!m) throw new Error(`Invalid duration “${d}”`);
  return Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
}

export function stringList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) {
    const xs = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (xs.length) return xs.map((x) => x.trim());
  }
  return fallback;
}
