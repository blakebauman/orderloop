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
