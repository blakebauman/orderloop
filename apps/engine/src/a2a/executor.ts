/**
 * What OrderLoop does with an A2A message. A new task is one of:
 *
 * - a typed skill, a data part `{ "skill": "find_orders", "input": { … } }`: the workspace tool
 *   runs as the caller (assistant/tools.ts), as it does over MCP;
 * - `place_order`: an order starts, at most once per message id;
 * - text: a chat turn with the assistant's model. Reads run directly; an action it proposes is
 *   previewed and the task waits (input-required) for `{ "confirm": true | false }`.
 *
 * A task about an order (placed, decided, delivered to or cancelled) then follows it: working
 * while it runs, input-required while it waits, and its outcome at the end. A reply on a waiting
 * order's task decides its approval (`{ "decision": "approved" }`) or delivers its event
 * (`{ "event": "payment.received" }`). Every act is the caller's own, checked against their role
 * as they are now, and the order's audit trail says "via A2A".
 */

import { type Message, Role } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
  type User,
} from '@a2a-js/sdk/server';
import {
  A2A_SKILLS,
  type A2ATaskState,
  ASSISTANT_TOOLS,
  type AssistantTool,
  atLeast,
  isA2ASkill,
  isAssistantTool,
  orderTaskState,
  type Principal,
  ROLE_LABELS,
  startOrderSchema,
} from '@orderloop/core';
import { generateText, type ModelMessage, stepCountIs, type ToolSet, tool } from 'ai';
import type { z } from 'zod';
import {
  type ActionInput,
  previewAction,
  Refused,
  resolveOrderId,
  snapshot,
} from '../assistant/data';
import { assistantModel, type ModelSource } from '../assistant/model';
import { isActionTool, runTool, TOOL_INPUTS, type ToolInput } from '../assistant/tools';
import { startOrderOnce } from '../orders';
import { dataArtifact, newTask, readMessage, statusEvent } from './parts';
import type { SqlTaskStore } from './store';

/** How long one request follows an order before handing back a task that is still working. */
const FOLLOW_MS = 25_000;
const POLL_MS = 1_000;

/** The caller, as the A2A SDK carries them through a request. */
export class PrincipalUser implements User {
  constructor(readonly principal: Principal) {}
  get isAuthenticated() {
    return true;
  }
  get userName() {
    return this.principal.id;
  }
}

export const principalOf = (context: ServerCallContext): Principal => {
  const user = context.user;
  if (!(user instanceof PrincipalUser)) throw new Refused('Unauthorized');
  return user.principal;
};

/** Tools whose task follows the order they act on. */
const ORDER_TOOLS = new Set<AssistantTool>(['decide_approval', 'deliver_event', 'cancel_order']);

type Ids = { taskId: string; contextId: string };

export class OrderLoopExecutor implements AgentExecutor {
  /** Tasks being followed by a request now; a cancel stops the follow. */
  private readonly following = new Set<string>();
  /** What an order showed just before this request acted on it, by task. */
  private readonly before = new Map<string, string>();

  constructor(
    private readonly env: Env,
    private readonly store: SqlTaskStore,
  ) {}

  execute = async (rc: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const ids = { taskId: rc.taskId, contextId: rc.contextId };
    const say = (state: A2ATaskState, text?: string) => bus.publish(statusEvent(ids, state, text));
    try {
      const p = principalOf(rc.context);
      // A stream starts with the task: a new one, or this one with the reply in its history.
      bus.publish(rc.task ? AgentEvent.task(rc.task) : newTask(ids, rc.userMessage));
      say('TASK_STATE_WORKING');
      const orderId = rc.task
        ? await this.reply(p, ids, rc.userMessage, bus)
        : await this.start(p, ids, rc.userMessage, bus);
      if (orderId) await this.follow(ids, orderId, bus);
    } catch (err) {
      if (err instanceof Refused) say('TASK_STATE_REJECTED', err.message);
      else {
        console.error('a2a: task failed', err);
        say(
          'TASK_STATE_FAILED',
          'Something went wrong. Try again, or check the order in OrderLoop.',
        );
      }
    } finally {
      this.before.delete(ids.taskId);
      bus.finished();
    }
  };

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    // The order itself is cancelled before this (A2AHandler.cancelTask); stop following it.
    this.following.delete(taskId);
    const task = await this.store.load(taskId);
    if (task)
      bus.publish(
        statusEvent({ taskId, contextId: task.contextId }, 'TASK_STATE_CANCELED', 'Cancelled.'),
      );
  };

  /** A new task. Returns the order it should follow, if any. */
  private async start(
    p: Principal,
    ids: Ids,
    message: Message,
    bus: ExecutionEventBus,
  ): Promise<string | null> {
    const { text, data } = readMessage(message);
    const skill = data?.skill;
    if (data && skill !== undefined) {
      if (!isA2ASkill(skill)) throw new Refused(`There is no skill called ${String(skill)}.`);
      if (skill === 'chat') return this.chatTurn(p, ids, text || data.text, bus);
      const min = A2A_SKILLS[skill].role;
      if (!atLeast(p.role, min)) throw new Refused(`This needs the ${ROLE_LABELS[min]} role.`);
      const input = (data.input ?? {}) as Record<string, unknown>;
      if (skill === 'place_order') return this.placeOrder(p, ids, message, input, bus);
      return this.runSkill(p, ids, skill, input, bus);
    }
    return this.chatTurn(p, ids, text, bus);
  }

  private async chatTurn(p: Principal, ids: Ids, prompt: unknown, bus: ExecutionEventBus) {
    if (typeof prompt !== 'string' || !prompt)
      throw new Refused('Send text to ask the assistant, or a data part { "skill", "input" }.');
    await this.chat(p, ids, prompt, bus);
    return null;
  }

  private async placeOrder(
    p: Principal,
    ids: Ids,
    message: Message,
    input: Record<string, unknown>,
    bus: ExecutionEventBus,
  ): Promise<string | null> {
    const parsed = startOrderSchema.safeParse(input);
    if (!parsed.success) throw new Refused(`The order is not valid: ${issues(parsed.error)}`);
    const result = await startOrderOnce(this.env, {
      ...parsed.data,
      startedBy: p.id,
      idempotencyKey: `a2a:${p.id}:${message.messageId}`,
    });
    if ('mismatch' in result)
      throw new Refused('This message id already placed a different order. Use a new message id.');
    bus.publish(dataArtifact(ids, 'order', result));
    await this.store.follow(ids.taskId, result.orderId);
    return result.orderId;
  }

  private async runSkill(
    p: Principal,
    ids: Ids,
    name: AssistantTool,
    raw: Record<string, unknown>,
    bus: ExecutionEventBus,
  ): Promise<string | null> {
    const parsed = (TOOL_INPUTS[name] as z.ZodObject).safeParse(raw);
    if (!parsed.success) throw new Refused(`The input is not valid: ${issues(parsed.error)}`);
    const input = parsed.data as ToolInput<typeof name>;
    const target = ORDER_TOOLS.has(name)
      ? await this.orderOf(input as { orderId?: unknown })
      : null;
    if (target) {
      const s = await snapshot(this.env, target);
      if (s) this.before.set(ids.taskId, key(orderTaskState(s)));
    }
    const result = await runTool(this.env, p, name, input, { via: 'A2A' });
    bus.publish(dataArtifact(ids, name, result));
    if (target) {
      await this.store.follow(ids.taskId, target);
      return target;
    }
    bus.publish(statusEvent(ids, 'TASK_STATE_COMPLETED'));
    return null;
  }

  /** A message on an existing task: a confirm, or a decision or event for its waiting order. */
  private async reply(
    p: Principal,
    ids: Ids,
    message: Message,
    bus: ExecutionEventBus,
  ): Promise<string | null> {
    const { data } = readMessage(message);
    const pending = this.store.pendingOf(ids.taskId);
    if (pending) {
      if (typeof data?.confirm !== 'boolean') {
        bus.publish(
          statusEvent(
            ids,
            'TASK_STATE_INPUT_REQUIRED',
            'Reply { "confirm": true } to go ahead, or { "confirm": false }.',
          ),
        );
        return null;
      }
      this.store.setPending(ids.taskId, null);
      if (!data.confirm) {
        bus.publish(statusEvent(ids, 'TASK_STATE_CANCELED', 'Left as it was. Nothing was sent.'));
        return null;
      }
      return this.runSkill(p, ids, pending.tool as AssistantTool, pending.input, bus);
    }
    const orderId = this.store.orderOf(ids.taskId);
    if (!orderId) throw new Refused('This task isn’t waiting for anything. Start a new task.');
    if (typeof data?.decision === 'string') {
      const input = { orderId, decision: data.decision, nodeId: data.nodeId, note: data.note };
      await this.runSkill(p, ids, 'decide_approval', input, bus);
    } else if (typeof data?.event === 'string') {
      await this.runSkill(p, ids, 'deliver_event', { orderId, event: data.event }, bus);
    } else {
      throw new Refused(
        'Reply { "decision": "approved" | "rejected", "nodeId"? } for an approval, or { "event": "…" } for an event.',
      );
    }
    return orderId;
  }

  /**
   * A chat turn over this conversation's history. The model reads freely; when it proposes an
   * action the task stops with a preview, for the caller to confirm.
   */
  private async chat(p: Principal, ids: Ids, prompt: string, bus: ExecutionEventBus) {
    const used: ModelSource = { source: 'model' };
    const proposed: { tool: AssistantTool; input: Record<string, unknown> }[] = [];
    const result = await generateText({
      model: assistantModel(this.env, { kind: 'workspace' }, used),
      system: systemPrompt(p),
      messages: [...this.earlier(ids), { role: 'user', content: prompt }],
      tools: this.tools(p),
      stopWhen: stepCountIs(6),
      temperature: 0.2,
    });
    for (const call of result.toolCalls)
      if (isAssistantTool(call.toolName) && isActionTool(call.toolName))
        proposed.push({ tool: call.toolName, input: call.input as Record<string, unknown> });
    const action = proposed[0];
    if (!action) {
      bus.publish(statusEvent(ids, 'TASK_STATE_COMPLETED', result.text || 'Done.'));
      return;
    }
    const preview = await previewAction(
      this.env,
      p,
      action.tool as keyof ActionInput,
      action.input as ActionInput[keyof ActionInput],
    );
    if (preview.blocked) {
      bus.publish(statusEvent(ids, 'TASK_STATE_COMPLETED', preview.blocked));
      return;
    }
    this.store.setPending(ids.taskId, action);
    bus.publish(dataArtifact(ids, 'proposal', { tool: action.tool, input: action.input, preview }));
    bus.publish(
      statusEvent(
        ids,
        'TASK_STATE_INPUT_REQUIRED',
        `${preview.title}: ${preview.consequences.join('; ')}. Reply { "confirm": true } to go ahead, or { "confirm": false }.`,
      ),
    );
  }

  /** The role's tools for the model. Actions have no `execute`: the turn stops at them. */
  private tools(p: Principal): ToolSet {
    const names = (Object.keys(ASSISTANT_TOOLS) as AssistantTool[]).filter((n) =>
      atLeast(p.role, ASSISTANT_TOOLS[n].role),
    );
    return Object.fromEntries(
      names.map((name) => {
        const { description } = ASSISTANT_TOOLS[name];
        const inputSchema = TOOL_INPUTS[name] as z.ZodObject;
        return [
          name,
          isActionTool(name)
            ? tool({ description: `${description} The caller confirms first.`, inputSchema })
            : tool({
                description,
                inputSchema,
                execute: (input: ToolInput<typeof name>) =>
                  runTool(this.env, p, name, input, { via: 'A2A' }),
              }),
        ];
      }),
    );
  }

  /** The conversation's earlier tasks (same context), as model messages. */
  private earlier(ids: Ids): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (const task of this.store.inContext(ids.contextId)) {
      if (task.id === ids.taskId) continue;
      const said = [...task.history, ...(task.status?.message ? [task.status.message] : [])];
      for (const m of said) {
        const { text, data } = readMessage(m);
        const content = text || (data ? JSON.stringify(data) : '');
        if (content)
          messages.push(
            m.role === Role.ROLE_AGENT ? { role: 'assistant', content } : { role: 'user', content },
          );
      }
    }
    return messages;
  }

  /** The order a tool acted on, by its full id. */
  private async orderOf(input: { orderId?: unknown }): Promise<string | null> {
    return typeof input.orderId === 'string' ? resolveOrderId(this.env, input.orderId) : null;
  }

  /**
   * Reports the order's state until it finishes or waits, or for FOLLOW_MS; after that the task
   * stays working and GetTask reads the order directly. Right after this request acted on the
   * order (a decision, an event), the order still shows the wait it resolved until its Workflow
   * resumes; that state is not news, so the follow keeps polling past it.
   */
  private async follow(ids: Ids, orderId: string, bus: ExecutionEventBus) {
    this.following.add(ids.taskId);
    const stale = this.before.get(ids.taskId);
    this.before.delete(ids.taskId);
    const until = Date.now() + FOLLOW_MS;
    let last = '';
    try {
      while (this.following.has(ids.taskId)) {
        const s = await snapshot(this.env, orderId);
        if (!s) return;
        const now = orderTaskState(s);
        const settled = key(now) !== stale;
        if (settled && key(now) !== last) {
          bus.publish(statusEvent(ids, now.state, now.text));
          last = key(now);
        }
        if ((settled && now.state !== 'TASK_STATE_WORKING') || Date.now() >= until) return;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } finally {
      this.following.delete(ids.taskId);
    }
  }
}

const key = (s: { state: string; text: string }) => `${s.state} ${s.text}`;

function systemPrompt(p: Principal) {
  return [
    'You are OrderLoop, answering another agent over A2A on behalf of one person in an order-operations team. OrderLoop runs every order as a flow graph of steps; people step in at approvals, events and exceptions.',
    `The person is ${p.name}${p.email ? ` <${p.email}>` : ''}, role ${p.role}.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Answer from tool results, never from memory or guesses. Be brief and exact. Name orders by their full id (ord_…).',
    'To decide, deliver an event, cancel, publish or run the stock review, call the tool: the caller sees exactly what will happen and confirms it. Never say an action happened.',
    'A tool you don’t have is one their role can’t use; say which role can.',
  ].join('\n');
}

const issues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
