/**
 * The workspace tools, once, for every channel that offers them: the assistant's model (AI SDK
 * tools in agent.ts) and MCP clients (mcp.ts). Names, roles, titles and descriptions are in
 * `ASSISTANT_TOOLS` (@orderloop/core); this adds each tool's input schema and what it runs.
 * Every run checks the caller's role first, as they are now; actions also re-check the action
 * against live data (`runAction`).
 */

import {
  type AssistantContext,
  type AssistantTool,
  type AuditVia,
  assessQuestionsSchema,
  CART_STATUSES,
  cartOpSchema,
  FULFILLMENT_METHODS,
  flowGraphSchema,
  isPageOnly,
  MAX_CART_TITLE,
  ORDER_CHANNELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  type Principal,
} from '@orderloop/core';
import {
  fieldRefSchema,
  MAX_DRAFT_FIELDS,
  PRODUCT_DRAFT_INSTRUCTION_MAX,
} from '@orderloop/core/product';
import { z } from 'zod';
import { changeCart, getCart, listCarts, openCart } from './carts';
import {
  type ActionInput,
  type ActionTool,
  AUDIT_CHANNEL,
  assessOrder,
  attention,
  type Channel,
  type Confirmed,
  findOrders,
  findProducts,
  getFlow,
  getOrder,
  listFlows,
  proposeFlowChange,
  Refused,
  requireRole,
  runAction,
} from './data';
import { createFlow, duplicateFlow, saveFlowDraft, setFlowArchived } from './flows';
import { startScenario } from './orders';

/** The audit trail of a write that needs no confirm: the channel, the tool, a page's button. */
const trailOf = (p: Principal, tool: AssistantTool, opts: { via: Channel; direct?: boolean }) => {
  // A connected app's grant and client, as `runAction` records them.
  const app = p as { grant?: string; client?: string };
  return {
    via: AUDIT_CHANNEL[opts.via],
    tool,
    ...(opts.direct ? { direct: true } : {}),
    ...(app.grant ? { grant: app.grant } : {}),
    ...(app.client ? { client: app.client } : {}),
  };
};

import { draftPlugin } from './plugin-draft';
import { draftProductContent } from './product-draft';

const auditVia = (via: Channel): AuditVia =>
  via === 'MCP' ? 'mcp' : via === 'A2A' ? 'a2a' : 'assistant';

const orderId = z.string().describe('The order id (ord_…) or its #reference, e.g. #k3x9q2');
const cartId = z.string().max(100).describe('The cart id (cart_…)');

/** Each tool's input. Built once per isolate. */
/**
 * What an event's own source writes: who delivered it, when, the outcome, and a provider's
 * receipt. A caller's payload can't set them, so a hand delivery never reads as a verified one.
 */
export const RESERVED_EVENT_FIELDS = new Set([
  'by',
  'event',
  'at',
  'outcome',
  'source',
  'provider',
  'invoiceId',
  'paymentIntentId',
  'note',
]);

export const TOOL_INPUTS = {
  needs_attention: z.object({}),
  find_orders: z.object({
    status: z.enum(ORDER_STATUSES).optional(),
    model: z.enum(ORDER_MODELS).optional(),
    channel: z.enum(ORDER_CHANNELS).optional(),
    customer: z.string().optional().describe('Customer name or id'),
    q: z.string().optional().describe('Free text over id, title and customer'),
    minTotal: z.number().optional(),
    maxTotal: z.number().optional(),
    sinceDays: z.number().int().positive().optional().describe('Created in the last N days'),
    sort: z.enum(['newest', 'updated', 'largest']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_order: z.object({ orderId }),
  assess_order: z.object({
    orderId,
    questions: assessQuestionsSchema.describe(
      'Question id → { type: "noul", instructions } | { type: "choice", instructions, criteria: { optionId: description } } | { type: "score", instructions, criteria: [levels, lowest first] }',
    ),
    images: z
      .array(z.string())
      .max(4)
      .optional()
      .describe("Up to 4 images: the order's R2 document keys, https or data URLs"),
  }),
  find_products: z.object({
    q: z.string().optional().describe('SKU or name'),
    belowReorder: z.boolean().optional().describe('Only SKUs at or below their reorder point'),
  }),
  list_carts: z.object({
    status: z.enum(CART_STATUSES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_cart: z.object({ cartId }),
  list_flows: z.object({}),
  get_flow: z.object({ flowId: z.string() }),
  propose_flow_change: z.object({ flowId: z.string(), instruction: z.string() }),
  draft_plugin: z.object({
    instruction: z
      .string()
      .describe('The rule in plain words, e.g. “hold orders over $5,000 shipping outside the US”'),
    pluginId: z
      .string()
      .optional()
      .describe('A plugin the assistant drafted (ai-…), to revise as its next version'),
  }),
  draft_product_content: z.object({
    key: z.string().min(1).max(128).describe('The catalog product’s key'),
    fields: z
      .array(fieldRefSchema)
      .min(1)
      .max(MAX_DRAFT_FIELDS)
      .optional()
      .describe('Fields and locales to draft; omit to draft the text the product is missing'),
    instruction: z
      .string()
      .max(PRODUCT_DRAFT_INSTRUCTION_MAX)
      .optional()
      .describe('Guidance from the person: tone, length, terms to keep'),
  }),
  create_cart: z.object({
    title: z.string().min(1).max(MAX_CART_TITLE),
    flowId: z.string().describe('A published flow with a Price lines step (list_flows)'),
    customerId: z.string().optional().describe('The customer it is for (cus_…)'),
  }),
  change_cart: z.object({
    cartId,
    ops: z
      .array(cartOpSchema)
      .min(1)
      .max(20)
      .describe('Applied in order; line ids come from get_cart'),
  }),
  decide_approval: z.object({
    orderId,
    nodeId: z
      .string()
      .optional()
      .describe('The approval step; omit when the order has only one open'),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().optional(),
  }),
  decide_approvals: z.object({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().max(2000).optional(),
    approvals: z
      .array(z.object({ orderId, nodeId: z.string().min(1).max(200) }))
      .min(1)
      .max(25)
      .describe('Each approval to decide: its order and the approval step'),
  }),
  deliver_event: z.object({
    orderId,
    event: z.string(),
    // Values no longer than the card shows; never a field that says who or what sent it.
    payload: z
      .record(
        z.string().min(1).max(60),
        z.union([z.string().max(120), z.number(), z.boolean(), z.null()]),
      )
      .refine((r) => Object.keys(r).length <= 20, 'At most 20 fields')
      .refine(
        (r) => !Object.keys(r).some((k) => RESERVED_EVENT_FIELDS.has(k)),
        `None of ${[...RESERVED_EVENT_FIELDS].join(', ')}`,
      )
      .optional()
      .describe('What the event carries, e.g. { "sellerId": "…", "decision": "accepted" }'),
  }),
  cancel_order: z.object({ orderId, reason: z.string() }),
  submit_cart: z.object({
    cartId,
    cartVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('The cart version you read (get_cart); refused if the cart has changed since'),
  }),
  publish_flow: z.object({ flowId: z.string() }),
  run_stock_review: z.object({}),
  start_order: z.object({
    flowId: z.string().max(100).describe('A published flow (list_flows)'),
    title: z.string().max(140).optional(),
    channel: z
      .enum(ORDER_CHANNELS)
      .optional()
      .describe('Where the order came from; manual if unsaid'),
    customerId: z.string().max(100).optional(),
    contact: z
      .object({ email: z.email().max(200), name: z.string().max(120).optional() })
      .optional()
      .describe('A guest buyer, when there is no customer'),
    fulfillment: z
      .object({
        method: z.enum(FULFILLMENT_METHODS),
        locationId: z.string().max(100).optional(),
      })
      .optional(),
    currency: z.string().length(3).optional(),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1).max(100),
          qty: z.number().int().positive().max(1_000_000),
        }),
      )
      .max(100),
    documentText: z.string().max(20_000).optional().describe('Text the flow reads (a PO or email)'),
  }),
  restart_order: z.object({ orderId }),
  start_scenario: z.object({ scenarioId: z.string().max(60).describe('A demo scenario id') }),
  cancel_cart: z.object({ cartId }),
  save_flow_draft: z.object({
    flowId: z.string().max(60),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    model: z.enum(ORDER_MODELS),
    channels: z.array(z.enum(ORDER_CHANNELS)).max(20).optional(),
    nodes: flowGraphSchema.shape.nodes.max(500),
    edges: flowGraphSchema.shape.edges.max(2000),
  }),
  create_flow: z.object({
    name: z.string().min(1).max(80),
    model: z.enum(ORDER_MODELS),
    start: z
      .enum(['template', 'blank', 'describe'])
      .describe('The model’s template, a blank start, or drafted from `prompt`'),
    prompt: z.string().max(4000).optional().describe('The steps, for start: describe'),
  }),
  duplicate_flow: z.object({ flowId: z.string().max(60) }),
  archive_flow: z.object({
    flowId: z.string().max(60),
    archived: z.boolean().describe('false restores it'),
  }),
  test_flow: z.object({ flowId: z.string().max(60) }),
} satisfies Record<AssistantTool, z.ZodObject>;

export type ToolInput<T extends AssistantTool> = z.infer<(typeof TOOL_INPUTS)[T]>;

// What each tool returns, as MCP's `outputSchema`. Loose objects: they name the fields a client
// can rely on and let a later field through, so adding one never fails a call.
const row = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const href = z.string().describe('Where to look in OrderLoop, e.g. /orders/ord_…');
const money = z.string().describe('Formatted in the order’s currency, e.g. $1,250.00');
const orderRow = row({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  status: z.string(),
  waitingAt: z.string().nullable().describe('The steps it is waiting at, joined with ·'),
  stoppedAt: z.string().nullable().describe('The steps it failed or stopped at'),
  total: money,
  href,
});

const cartOutput = row({
  id: z.string(),
  href,
  title: z.string(),
  status: z.string(),
  lines: z.array(row({ lineId: z.string(), sku: z.string(), qty: z.number() })),
  shipTo: row({}).nullable().describe('Where it ships (set_ship_to); null until set'),
  shippingOption: z
    .string()
    .nullable()
    .describe('The option it ships by: what the current quote charged, else the one chosen'),
  shippingOptions: z
    .array(row({ id: z.string(), title: z.string(), price: money }))
    .describe('What the flow offers for the ship-to; choose one with set_shipping_option'),
  priced: z.boolean().describe('Whether the total prices the cart as it is now'),
  total: money.describe('Formatted in the quote’s currency; empty until priced'),
  notReady: z.string().nullable().describe('Why it can’t be submitted yet; null when it can'),
});

/** An action's result: a preview and code on the first call, what was done on the second. */
const actionOutput = row({
  preview: row({
    title: z.string(),
    consequences: z.array(z.string()),
    href: z.string().optional(),
  }).optional(),
  confirmation: z.string().optional().describe('Send it back with the same input once agreed'),
  expiresAt: z.number().optional(),
  next: z.string().optional(),
  done: z.string().optional().describe('What happened, once the action ran'),
  href: z.string().optional(),
});

export const TOOL_OUTPUTS = {
  needs_attention: row({
    approvals: z.array(row({ id: z.string(), orderId: z.string(), title: z.string() })),
    failed: z.array(row({ id: z.string(), title: z.string(), status: z.string() })),
    stalled: z.array(row({ id: z.string(), title: z.string() })),
    counts: row({ approvals: z.number(), failed: z.number(), stalled: z.number() }),
  }),
  find_orders: row({
    count: z.number().describe('All matches, not only the rows shown'),
    total: money.describe('The total of all matches, in USD'),
    shown: z.number(),
    orders: z.array(orderRow),
  }),
  get_order: row({
    id: z.string(),
    ref: z.string(),
    href,
    title: z.string(),
    status: z.string(),
    total: money,
    waits: z.array(
      row({
        nodeId: z.string(),
        step: z.string().describe('The label of the step it waits at'),
        since: z.string(),
        kind: z.string(),
        title: z.string(),
      }),
    ),
    steps: z.array(row({ nodeId: z.string(), step: z.string(), status: z.string() })),
    recent: z.array(row({ at: z.string(), message: z.string() })),
  }),
  assess_order: row({
    id: z.string(),
    ref: z.string(),
    answers: z.record(z.string(), row({ type: z.string() })),
    images: z.number().describe('Images the assessment used'),
    notes: z.array(z.string()),
    source: z.enum(['model', 'heuristic']),
  }),
  find_products: row({
    products: z.array(
      row({ sku: z.string(), name: z.string(), stock: z.number(), available: z.number() }),
    ),
    href,
  }),
  list_carts: row({
    shown: z.number(),
    carts: z.array(row({ id: z.string(), title: z.string(), status: z.string(), href })),
  }),
  get_cart: cartOutput,
  list_flows: row({
    flows: z.array(row({ id: z.string(), name: z.string(), href })),
  }),
  get_flow: row({
    id: z.string(),
    name: z.string(),
    href,
    steps: z.array(row({ id: z.string(), type: z.string(), label: z.string() })),
    connections: z.array(z.string()),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  propose_flow_change: row({
    flowId: z.string(),
    flowName: z.string(),
    explanation: z.string(),
    graph: row({ nodes: z.array(row({})), edges: z.array(row({})) }),
    changes: row({
      added: z.number(),
      removed: z.number(),
      edited: z.number(),
      rewired: z.number(),
    }),
  }),
  draft_plugin: row({
    id: z.string().describe('The drafted plugin, ai-…'),
    sha: z.string(),
    name: z.string(),
    version: z.string(),
    explanation: z.string(),
    nodes: z.array(row({ type: z.string(), label: z.string() })),
    cases: row({ total: z.number(), passed: z.number() }),
    href: href.describe('Where an admin reviews, tests and approves it'),
  }),
  draft_product_content: row({
    key: z.string(),
    title: z.string(),
    drafted: z.array(row({ ref: row({ field: z.string() }), value: z.string() })),
    refused: z.array(row({ ref: row({ field: z.string() }), issues: z.array(z.string()) })),
    model: z.string().nullable().describe('The model that wrote them'),
  }),
  create_cart: cartOutput,
  change_cart: cartOutput.extend({ applied: z.number().describe('Ops applied') }),
  decide_approval: actionOutput,
  decide_approvals: actionOutput.extend({
    results: z
      .array(
        row({
          orderId: z.string(),
          nodeId: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      )
      .optional()
      .describe('How each approval went, once confirmed'),
  }),
  deliver_event: actionOutput,
  cancel_order: actionOutput,
  submit_cart: actionOutput,
  publish_flow: actionOutput,
  run_stock_review: actionOutput,
  start_order: actionOutput,
  restart_order: actionOutput,
  start_scenario: actionOutput,
  cancel_cart: actionOutput,
  save_flow_draft: row({
    done: z.string(),
    href: z.string(),
    id: z.string(),
    errors: z.array(row({ message: z.string() })),
    warnings: z.array(row({ message: z.string() })),
  }),
  create_flow: row({ done: z.string(), href: z.string(), id: z.string() }),
  duplicate_flow: row({ done: z.string(), href: z.string(), id: z.string() }),
  archive_flow: row({ done: z.string(), href: z.string(), id: z.string() }),
  test_flow: actionOutput,
} satisfies Record<AssistantTool, z.ZodObject>;

export const ACTION_TOOLS: ActionTool[] = [
  'decide_approval',
  'decide_approvals',
  'deliver_event',
  'cancel_order',
  'submit_cart',
  'publish_flow',
  'run_stock_review',
  'start_order',
  'restart_order',
  'cancel_cart',
  'test_flow',
];

export const isActionTool = (name: AssistantTool): name is ActionTool =>
  ACTION_TOOLS.includes(name as ActionTool);

/**
 * Runs a tool as `p`. `via` names the channel in the order's audit trail ("… via MCP");
 * `context` is the assistant panel's page, which only the flow draft uses; `confirmed` is what
 * an action's confirm was held to (`runAction`); `direct` marks a call a page's own button made
 * through the assistant (`act`), so the audit trail tells it apart from one a model proposed.
 */
export async function runTool<T extends AssistantTool>(
  env: Env,
  p: Principal,
  name: T,
  input: ToolInput<T>,
  opts: {
    via: Channel;
    context?: AssistantContext;
    confirmed?: Confirmed;
    direct?: boolean;
    /** Unique to this call (a page's `act` id): an order it starts, it starts once. */
    key?: string;
  },
): Promise<unknown> {
  if (isActionTool(name))
    return runAction(
      env,
      p,
      name,
      input as ActionInput[typeof name],
      opts.via,
      opts.confirmed,
      opts.direct,
      opts.key,
    );
  requireRole(p, name);
  // Only from the page's own button: the model, MCP and A2A never see it, and can't call it.
  if (isPageOnly(name) && !opts.direct) throw new Refused('This runs only from its page.');
  switch (name) {
    case 'needs_attention':
      return attention(env);
    case 'find_orders':
      return findOrders(env, input as ToolInput<'find_orders'>);
    case 'get_order':
      return getOrder(env, (input as ToolInput<'get_order'>).orderId);
    case 'assess_order': {
      const i = input as ToolInput<'assess_order'>;
      return assessOrder(env, i.orderId, i.questions, i.images);
    }
    case 'find_products': {
      const i = input as ToolInput<'find_products'>;
      return findProducts(env, i.q, i.belowReorder);
    }
    case 'list_carts':
      return listCarts(env, input as ToolInput<'list_carts'>);
    case 'get_cart':
      return getCart(env, (input as ToolInput<'get_cart'>).cartId);
    case 'create_cart':
      return openCart(env, p, input as ToolInput<'create_cart'>, opts.via);
    case 'change_cart': {
      const i = input as ToolInput<'change_cart'>;
      return changeCart(env, p, i.cartId, i.ops, opts.via, opts.direct);
    }
    case 'list_flows':
      return listFlows(env);
    case 'get_flow':
      return getFlow(env, (input as ToolInput<'get_flow'>).flowId);
    case 'propose_flow_change': {
      const i = input as ToolInput<'propose_flow_change'>;
      const c = opts.context;
      const onScreen = c?.kind === 'flow' && c.id === i.flowId ? c : undefined;
      return proposeFlowChange(env, i.flowId, i.instruction, onScreen);
    }
    case 'draft_plugin': {
      const i = input as ToolInput<'draft_plugin'>;
      return draftPlugin(env, p, i.instruction, { pluginId: i.pluginId, via: auditVia(opts.via) });
    }
    case 'save_flow_draft':
      return saveFlowDraft(env, p, input as ToolInput<'save_flow_draft'>, trailOf(p, name, opts));
    case 'create_flow':
      return createFlow(env, p, input as ToolInput<'create_flow'>, trailOf(p, name, opts));
    case 'duplicate_flow':
      return duplicateFlow(
        env,
        p,
        (input as ToolInput<'duplicate_flow'>).flowId,
        trailOf(p, name, opts),
      );
    case 'archive_flow': {
      const i = input as ToolInput<'archive_flow'>;
      return setFlowArchived(env, p, i.flowId, i.archived, trailOf(p, name, opts));
    }
    case 'start_scenario':
      return startScenario(
        env,
        p,
        (input as ToolInput<'start_scenario'>).scenarioId,
        trailOf(p, name, opts),
      );
    case 'draft_product_content': {
      const { key, ...request } = input as ToolInput<'draft_product_content'>;
      return draftProductContent(env, p, key, request, auditVia(opts.via));
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}
