/**
 * Decision-model routing for typed requests: cheaper turns when the request is one exact call.
 *
 * With the workspace's routing on (`ASSISTANT_ROUTING_KEY`, set by an admin), a new question is
 * first read by the fixed rules (`heuristicStep`) into one tool call, using the page in front of
 * the person ("cancel this order"). Clef (`ASSESS_MODEL`) is then asked one yes/no question: does
 * the request ask for exactly that, and nothing else? When it is sure, the turn runs on the fixed
 * rules (`heuristicModel`), which call that tool and describe what it returned, and no chat model
 * runs. Anything else (no call the rules can build, a no, an unsure answer, Clef unavailable) goes
 * to the chat model as before.
 *
 * Nothing changes what a call may do: the tools offered are the person's, an action still stops at
 * its confirm card, and `runAction` checks it all again. Clef reads only the person's own words and
 * the page they're on, never a tool's result.
 */

import {
  ASSISTANT_ROUTING_KEY,
  ASSISTANT_TOOLS,
  type AssistantContext,
  boundText,
  isWriteTool,
  type Principal,
} from '@orderloop/core';
import { createDb, workspaceSettings } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { assess } from '../clef';
import { recordAssistantUsage } from '../usage';
import { heuristicStep } from './model';

/** How sure Clef must be that the request is exactly the rules' call. */
export const ROUTING_THRESHOLD = 0.85;

/** The workspace's routing is on (off until an admin turns it on). */
export async function routingOn(env: Env): Promise<boolean> {
  const row = await createDb(env.DB)
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, ASSISTANT_ROUTING_KEY))
    .get();
  return row?.value === 'on';
}

export type Route =
  | { route: 'rules'; tool: string; yes: number }
  | { route: 'model'; reason: 'off' | 'mock' | 'no call' | 'unsure' | 'unavailable' };

/**
 * Where a new question goes: the fixed rules when Clef is sure they read it right, else the chat
 * model. `tools` are the ones the person may use this turn.
 */
export async function routeQuestion(
  env: Env,
  p: Principal,
  text: string,
  context: AssistantContext,
  tools: Set<string>,
): Promise<Route> {
  // Mock mode answers from the rules already; there is nothing to route.
  if (String(env.AI_MODE) === 'mock') return { route: 'model', reason: 'mock' };
  if (!(await routingOn(env))) return { route: 'model', reason: 'off' };
  const step = heuristicStep(text, context, tools);
  if (!('tool' in step)) return { route: 'model', reason: 'no call' };
  const spec = ASSISTANT_TOOLS[step.tool];
  // Only a read, or an action that stops at its card: never a write that runs without one (a
  // drafted plugin, product copy), nor a proposal that calls a model of its own, however sure
  // Clef is.
  if ((!spec.confirm && isWriteTool(step.tool)) || step.tool === 'propose_flow_change')
    return { route: 'model', reason: 'no call' };
  const answer = await assess(env, {
    state: {
      request: boundText(text, 2000),
      page: context.kind === 'workspace' ? 'the workspace' : `${context.kind} ${context.id}`,
      proposed: { action: spec.title, does: spec.description, with: step.input },
    },
    questions: {
      exact: {
        type: 'noul',
        instructions:
          'Is the request asking for exactly the proposed action, with these inputs, and nothing more: no other question to answer, no explanation, comparison or judgement asked for?',
      },
    },
  });
  const usage = answer.value.usage;
  if (usage) await recordAssistantUsage(env, p, usage.input_tokens + usage.output_tokens);
  if (answer.source !== 'model') return { route: 'model', reason: 'unavailable' };
  const exact = answer.value.answers.exact;
  const yes = exact?.type === 'noul' ? exact.noul : 0;
  return yes >= ROUTING_THRESHOLD
    ? { route: 'rules', tool: step.tool, yes }
    : { route: 'model', reason: 'unsure' };
}
