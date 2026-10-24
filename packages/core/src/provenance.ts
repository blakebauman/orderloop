/**
 * Where an AI step's answer came from, recorded with every answer in the step's output: the model
 * that gave it (none for the heuristic), the prompt by name and version, and why it fell back if it
 * did. Bump a prompt's version whenever its instructions or its answer schema change, so a step's
 * output says which wording produced it.
 */

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
};

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
