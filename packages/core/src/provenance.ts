/**
 * Where an AI step's answer came from, recorded with every answer in the step's output: the model
 * that gave it (none for the heuristic), the prompt by name and version, and why it fell back if it
 * did. Bump a prompt's version whenever its instructions or its answer schema change, so a step's
 * output says which wording produced it.
 */

import type { OrderState } from './api';

export const AI_PROMPTS = {
  extract: 1,
  classify: 1,
  risk: 1,
  forecast: 1,
  router: 1,
  summarize: 1,
  copilot: 1,
  assess: 1,
  assistant: 1,
  plugin_draft: 1,
  product_draft: 1,
  cart_reply: 1,
} as const;

export type AiPrompt = keyof typeof AI_PROMPTS;

/** `extract@1`. */
export const promptId = (p: AiPrompt) => `${p}@${AI_PROMPTS[p]}`;

export type AiSource = 'model' | 'heuristic';

export type AiProvenance = {
  source: AiSource;
  /** The model that answered; null when the heuristic did. */
  model: string | null;
  prompt: string;
  /** Why the model's answer wasn't used: mock mode, a timeout, an error, or a malformed answer. */
  fallback?: string;
  /**
   * The model call's AI Gateway log entry, kept only while the deployment's gateway logs are on
   * (otherwise there's no entry), so a person's later decision can be sent back as feedback.
   */
  logId?: string;
};

/** AI steps whose branches can send an order to a person's review. */
export const AI_GATES: ReadonlySet<string> = new Set(['ai.risk_score', 'ai.router', 'ai.assess']);

/** Feedback for the model call behind a decided review: 1 when it was needed, -1 when it wasn't. */
export type AiFeedback = { nodeId: string; prompt: string; logId: string; feedback: 1 | -1 };

/** How far back through earlier approvals (an escalation into this one) to look for the gate. */
const MAX_HOPS = 4;

/**
 * When a person decides the approval `approvalNodeId`, the model call to mark: the AI gate whose
 * taken branch led to it (directly, or through earlier approvals that escalated here). Rejecting
 * says the gate was right to stop the order (+1); approving says the review wasn't needed (-1).
 * Nothing when the gate's answer came from the heuristic, the call has no log entry, or no AI gate
 * sent the order here (a credit limit, a budget, a condition).
 */
export function aiGateFeedback(
  state: OrderState,
  approvalNodeId: string,
  decision: 'approved' | 'rejected',
  hops = 0,
): AiFeedback | null {
  const flow = state.flow;
  if (!flow) return null;
  for (const e of flow.edges.filter((x) => x.target === approvalNodeId)) {
    const run = state.nodes[e.source];
    const source = flow.nodes.find((n) => n.id === e.source);
    if (!run || !source || run.status !== 'succeeded') continue;
    // Only the branch that actually led here.
    if (e.sourceHandle && run.branches && !run.branches.includes(e.sourceHandle)) continue;
    if (source.type === 'control.approval') {
      if (hops >= MAX_HOPS) continue;
      const earlier = aiGateFeedback(state, source.id, decision, hops + 1);
      if (earlier) return earlier;
      continue;
    }
    if (!AI_GATES.has(source.type)) continue;
    const out = run.output as (Partial<AiProvenance> & { unchecked?: boolean }) | undefined;
    if (out?.source !== 'model' || !out.logId || !out.prompt || out.unchecked) continue;
    return {
      nodeId: source.id,
      prompt: out.prompt,
      logId: out.logId,
      feedback: decision === 'rejected' ? 1 : -1,
    };
  }
  return null;
}

/** Tokens a person's assistant conversations may use a day, unless the deployment sets another. */
export const ASSISTANT_DAILY_TOKENS = 1_000_000;

/** The daily budget a deployment's `ASSISTANT_DAILY_TOKENS` asks for; `0` means no limit. */
export function assistantDailyTokens(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < 0) return ASSISTANT_DAILY_TOKENS;
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

/** The UTC day a use counts against, `2026-10-17`. */
export const usageDay = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

export const ASSISTANT_BUDGET_SPENT =
  "You've used today's assistant allowance. It resets at midnight UTC; your OrderLoop contact can raise it.";
