/**
 * AssistantAgent: the workspace assistant, one Durable Object per person (the web app names the
 * instance after the signed-in principal and forces that name, so nobody can open another person's
 * thread). Built on AIChatAgent: the conversation lives in this object's SQLite, a reply keeps
 * streaming if the tab goes away and resumes when it comes back, and tools that act on orders or
 * flows stop for the person to confirm (`needsApproval`) before they run.
 *
 * The caller's role decides which tools the model is offered, and each tool checks the role again,
 * as the person is now, when it runs.
 */

import { AIChatAgent } from '@cloudflare/ai-chat';
import {
  ASSISTANT_TOOLS,
  type AssistantContext,
  type AssistantTool,
  atLeast,
  decodePrincipal,
  flowGraphSchema,
  ORDER_CHANNELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
} from '@orderloop/core';
import type { Connection, ConnectionContext } from 'agents';
import { callable } from 'agents';
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type Tool,
  type ToolSet,
  tool,
} from 'ai';
import { z } from 'zod';
import { livePrincipal, SESSION_ENDED } from '../principal';
import {
  type ActionInput,
  type ActionTool,
  attention,
  findOrders,
  findProducts,
  getFlow,
  getOrder,
  listFlows,
  previewAction,
  proposeFlowChange,
  Refused,
  requireRole,
  runAction,
} from './data';
import { assistantModel, type ModelSource } from './model';

const ACTION_TOOLS: ActionTool[] = [
  'decide_approval',
  'deliver_event',
  'cancel_order',
  'publish_flow',
  'run_stock_review',
];

export class AssistantAgent extends AIChatAgent<Env> {
  override maxPersistedMessages = 200;

  /** Kept per instance: the proxy always connects a person to their own assistant. */
  override async onConnect(connection: Connection, ctx: ConnectionContext) {
    const p = decodePrincipal(ctx.request.headers.get(PRINCIPAL_HEADER));
    if (!p || p.id !== this.name) {
      connection.close(4403, 'Not your assistant');
      return;
    }
    await this.ctx.storage.put('principal', p);
  }

  /** The person this assistant works for, as they are now; throws once their sign-in has ended. */
  private async caller(): Promise<Principal> {
    const stored = await this.ctx.storage.get<ProxiedPrincipal>('principal');
    const p = stored ? await livePrincipal(this.env, stored) : null;
    if (!p) throw new Refused(SESSION_ENDED);
    return p;
  }

  /** What is waiting on people, for the line at the top of the panel. */
  @callable()
  async attention() {
    await this.caller();
    return attention(this.env);
  }

  /** An action resolved against live data, for its confirm card. */
  @callable()
  async preview(name: string, input: unknown) {
    const p = await this.caller();
    if (!ACTION_TOOLS.includes(name as ActionTool)) throw new Error(`Not an action: ${name}`);
    return previewAction(this.env, p, name as ActionTool, input as ActionInput[ActionTool]);
  }

  override async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0],
    options?: { abortSignal?: AbortSignal; body?: Record<string, unknown> },
  ) {
    let p: Principal;
    try {
      p = await this.caller();
    } catch (err) {
      return new Response(err instanceof Error ? err.message : SESSION_ENDED, {
        headers: { 'content-type': 'text/plain' },
      });
    }
    const context = readContext(options?.body?.context);
    const used: ModelSource = { source: 'model' };
    const result = streamText({
      model: assistantModel(this.env, context, used),
      system: systemPrompt(p, context),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: 'before-last-message',
        toolCalls: 'before-last-2-messages',
      }),
      tools: this.tools(p, context),
      stopWhen: stepCountIs(6),
      temperature: 0.2,
      abortSignal: options?.abortSignal,
      onFinish,
    });
    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) =>
        part.type === 'finish' ? { source: used.source, at: Date.now() } : undefined,
    });
  }

  /** The tools this person's role allows; each checks the role again when it runs. */
  private tools(p: Principal, context: AssistantContext): ToolSet {
    const env = this.env;
    // Reads and drafts run directly, as the person is when the tool runs.
    const as = async (name: AssistantTool) => {
      const now = await this.caller();
      requireRole(now, name);
      return now;
    };
    // Actions stop for the person to confirm; `runAction` re-checks everything when they do.
    const act = async <T extends ActionTool>(name: T, input: ActionInput[T]) =>
      runAction(env, await this.caller(), name, input);
    const orderId = z.string().describe('The order id (ord_…) or its #reference, e.g. #k3x9q2');
    const all: Record<AssistantTool, Tool> = {
      needs_attention: tool({
        description:
          'What is waiting on people: open approvals (oldest first), orders that failed or rolled back in the last 3 days, and orders waiting on a business event for over a day.',
        inputSchema: z.object({}),
        execute: async () => {
          await as('needs_attention');
          return attention(env);
        },
      }),
      find_orders: tool({
        description:
          'Search orders. Totals compare in USD. Returns the count and total of all matches plus up to `limit` rows.',
        inputSchema: z.object({
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
        execute: async (f) => {
          await as('find_orders');
          return findOrders(env, f);
        },
      }),
      get_order: tool({
        description:
          'One order: status, what it waits on (with where each decision leads), steps run so far and recent activity.',
        inputSchema: z.object({ orderId }),
        execute: async (i) => {
          await as('get_order');
          return getOrder(env, i.orderId);
        },
      }),
      find_products: tool({
        description: 'Products with stock, reserved and available quantities and reorder points.',
        inputSchema: z.object({
          q: z.string().optional().describe('SKU or name'),
          belowReorder: z
            .boolean()
            .optional()
            .describe('Only SKUs at or below their reorder point'),
        }),
        execute: async (i) => {
          await as('find_products');
          return findProducts(env, i.q, i.belowReorder);
        },
      }),
      list_flows: tool({
        description: 'All flows and their published versions.',
        inputSchema: z.object({}),
        execute: async () => {
          await as('list_flows');
          return listFlows(env);
        },
      }),
      get_flow: tool({
        description: 'A flow’s saved draft: its steps, connections and validation problems.',
        inputSchema: z.object({ flowId: z.string() }),
        execute: async (i) => {
          await as('get_flow');
          return getFlow(env, i.flowId);
        },
      }),
      propose_flow_change: tool({
        description:
          'Draft a change to a flow from an instruction. Nothing is saved: the person reviews the proposal in the editor and applies it there.',
        inputSchema: z.object({ flowId: z.string(), instruction: z.string() }),
        execute: async (i) => {
          await as('propose_flow_change');
          const onScreen = context.kind === 'flow' && context.id === i.flowId ? context : undefined;
          return proposeFlowChange(env, i.flowId, i.instruction, onScreen);
        },
      }),
      decide_approval: tool({
        description:
          'Approve or reject an approval an order is waiting on. The person confirms before it is sent.',
        inputSchema: z.object({
          orderId,
          nodeId: z
            .string()
            .optional()
            .describe('The approval step; omit when the order has only one open'),
          decision: z.enum(['approved', 'rejected']),
          note: z.string().optional(),
        }),
        needsApproval: true,
        execute: (i) => act('decide_approval', i),
      }),
      deliver_event: tool({
        description:
          'Deliver a business event (e.g. payment.received) to the order waiting for it. The person confirms first.',
        inputSchema: z.object({ orderId, event: z.string() }),
        needsApproval: true,
        execute: (i) => act('deliver_event', i),
      }),
      cancel_order: tool({
        description:
          'Cancel an order and undo what it did (release stock, void payment, cancel shipments). The person confirms first.',
        inputSchema: z.object({ orderId, reason: z.string() }),
        needsApproval: true,
        execute: (i) => act('cancel_order', i),
      }),
      publish_flow: tool({
        description: 'Publish a flow’s saved draft as a new version. The person confirms first.',
        inputSchema: z.object({ flowId: z.string() }),
        needsApproval: true,
        execute: (i) => act('publish_flow', i),
      }),
      run_stock_review: tool({
        description:
          'Run the daily stock review now; it starts reorders for SKUs at or below their reorder point. The person confirms first.',
        inputSchema: z.object({}),
        needsApproval: true,
        execute: () => act('run_stock_review', {}),
      }),
    };
    return Object.fromEntries(
      (Object.keys(all) as AssistantTool[])
        .filter((name) => atLeast(p.role, ASSISTANT_TOOLS[name].role))
        .map((name) => [name, all[name]]),
    );
  }
}

/** The page the person is on, as the panel sent it; anything malformed counts as the workspace. */
export function readContext(raw: unknown): AssistantContext {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (c.kind === 'order' && typeof c.id === 'string')
    return { kind: 'order', id: c.id, label: String(c.label ?? c.id).slice(0, 120) };
  if (c.kind === 'flow' && typeof c.id === 'string') {
    const graph = flowGraphSchema.safeParse(c.graph);
    return {
      kind: 'flow',
      id: c.id,
      label: String(c.label ?? c.id).slice(0, 120),
      ...(graph.success ? { graph: graph.data } : {}),
      ...(typeof c.model === 'string' ? { model: c.model } : {}),
    };
  }
  return { kind: 'workspace' };
}

function systemPrompt(p: Principal, context: AssistantContext) {
  const where =
    context.kind === 'order'
      ? `They are looking at order ${context.id} (${context.label}). “This order” means that one.`
      : context.kind === 'flow'
        ? `They are editing the flow ${context.id} (${context.label}). “This flow” means that one; proposals start from the graph on their screen.`
        : 'They are not looking at a particular order or flow.';
  return [
    'You are the OrderLoop assistant, working for one person in an order-operations team. OrderLoop runs every order as a flow graph of steps; people step in at approvals, events and exceptions.',
    `The person is ${p.name}${p.email ? ` <${p.email}>` : ''}, role ${p.role}. ${where}`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Answer from tool results, never from memory or guesses. Be brief and exact: a sentence or two, then a short list when there are several items. No greetings, no filler, no emoji.',
    'Link orders as [#abc123](/orders/<full id>) using the last six characters of the id, and flows as [Name](/flows/<id>).',
    'To decide, deliver an event, cancel, publish or run the stock review, call the tool: the person sees exactly what will happen and confirms it themselves. Never say an action happened unless its tool returned `done`. If they decline, say it was left as it was.',
    'A tool you don’t have is one their role can’t use; say which role can.',
  ].join('\n');
}
