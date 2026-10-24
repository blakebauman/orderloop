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
  assessQuestionsSchema,
  ORDER_CHANNELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  type Principal,
} from '@orderloop/core';
import { z } from 'zod';
import {
  type ActionInput,
  type ActionTool,
  assessOrder,
  attention,
  type Channel,
  findOrders,
  findProducts,
  getFlow,
  getOrder,
  listFlows,
  proposeFlowChange,
  requireRole,
  runAction,
} from './data';

const orderId = z.string().describe('The order id (ord_…) or its #reference, e.g. #k3x9q2');

/** Each tool's input. Built once per isolate. */
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
  list_flows: z.object({}),
  get_flow: z.object({ flowId: z.string() }),
  propose_flow_change: z.object({ flowId: z.string(), instruction: z.string() }),
  decide_approval: z.object({
    orderId,
    nodeId: z
      .string()
      .optional()
      .describe('The approval step; omit when the order has only one open'),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().optional(),
  }),
  deliver_event: z.object({ orderId, event: z.string() }),
  cancel_order: z.object({ orderId, reason: z.string() }),
  publish_flow: z.object({ flowId: z.string() }),
  run_stock_review: z.object({}),
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
  total: money,
  href,
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
    waits: z.array(row({ nodeId: z.string(), kind: z.string(), title: z.string() })),
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
  decide_approval: actionOutput,
  deliver_event: actionOutput,
  cancel_order: actionOutput,
  publish_flow: actionOutput,
  run_stock_review: actionOutput,
} satisfies Record<AssistantTool, z.ZodObject>;

export const ACTION_TOOLS: ActionTool[] = [
  'decide_approval',
  'deliver_event',
  'cancel_order',
  'publish_flow',
  'run_stock_review',
];

export const isActionTool = (name: AssistantTool): name is ActionTool =>
  ACTION_TOOLS.includes(name as ActionTool);

/**
 * Runs a tool as `p`. `via` names the channel in the order's audit trail ("… via MCP");
 * `context` is the assistant panel's page, which only the flow draft uses.
 */
export async function runTool<T extends AssistantTool>(
  env: Env,
  p: Principal,
  name: T,
  input: ToolInput<T>,
  opts: { via: Channel; context?: AssistantContext },
): Promise<unknown> {
  if (isActionTool(name))
    return runAction(env, p, name, input as ActionInput[typeof name], opts.via);
  requireRole(p, name);
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
  }
  throw new Error(`Unknown tool: ${name}`);
}
