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
  type ToolSet,
  tool,
} from 'ai';
import type { z } from 'zod';
import { livePrincipal, SESSION_ENDED } from '../principal';
import { type ActionInput, type ActionTool, attention, previewAction, Refused } from './data';
import { assistantModel, type ModelSource } from './model';
import { ACTION_TOOLS, runTool, TOOL_INPUTS, type ToolInput } from './tools';

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

  /**
   * The tools this person's role allows (tools.ts). Each runs as the person is when it runs;
   * actions stop for them to confirm first, and `runAction` re-checks everything when they do.
   */
  private tools(p: Principal, context: AssistantContext): ToolSet {
    const names = (Object.keys(ASSISTANT_TOOLS) as AssistantTool[]).filter((name) =>
      atLeast(p.role, ASSISTANT_TOOLS[name].role),
    );
    return Object.fromEntries(
      names.map((name) => {
        const { confirm, description } = ASSISTANT_TOOLS[name];
        return [
          name,
          tool({
            description: confirm ? `${description} The person confirms first.` : description,
            inputSchema: TOOL_INPUTS[name] as z.ZodObject,
            ...(confirm ? { needsApproval: true } : {}),
            execute: async (input: ToolInput<typeof name>) =>
              runTool(this.env, await this.caller(), name, input, { via: 'assistant', context }),
          }),
        ];
      }),
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
