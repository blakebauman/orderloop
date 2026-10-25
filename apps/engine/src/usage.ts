/**
 * The assistant's daily token budget per person (`ASSISTANT_DAILY_TOKENS`, a million unless the
 * deployment sets another; `0` is no limit). A conversation turn is refused once the person has
 * used the day's tokens; what a turn uses is added when it finishes. Turns the heuristic answers
 * cost nothing. Covers the in-app assistant and A2A chat; MCP clients bring their own model.
 */

import { assistantDailyTokens, type Principal, promptId, usageDay } from '@orderloop/core';
import { aiUsage, createDb } from '@orderloop/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { logAiCall } from './ai';
import type { ModelSource } from './assistant/model';

/** True when this person has no tokens left today. */
export async function assistantBudgetSpent(env: Env, p: Principal, now = Date.now()) {
  const limit = assistantDailyTokens(env.ASSISTANT_DAILY_TOKENS);
  if (!Number.isFinite(limit)) return false;
  const row = await createDb(env.DB)
    .select({ tokens: aiUsage.tokens })
    .from(aiUsage)
    .where(and(eq(aiUsage.principalId, p.id), eq(aiUsage.day, usageDay(now))))
    .get();
  return (row?.tokens ?? 0) >= limit;
}

/** Adds a finished turn's tokens to the person's day. */
export async function recordAssistantUsage(
  env: Env,
  p: Principal,
  tokens: number | undefined,
  now = Date.now(),
) {
  const used = Math.max(0, Math.round(tokens ?? 0));
  await createDb(env.DB)
    .insert(aiUsage)
    .values({ principalId: p.id, day: usageDay(now), tokens: used, calls: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.principalId, aiUsage.day],
      set: { tokens: sql`${aiUsage.tokens} + ${used}`, calls: sql`${aiUsage.calls} + 1` },
    });
}

/** Drops days older than 90 (the retention sweep). */
export async function pruneUsage(env: Env, now = Date.now()) {
  const gone = await createDb(env.DB)
    .delete(aiUsage)
    .where(lt(aiUsage.day, usageDay(now - 90 * 86_400_000)))
    .returning({ day: aiUsage.day });
  return gone.length;
}

/** Counts a finished turn against the person's budget and logs it as an `ai_call`. */
export async function finishTurn(
  env: Env,
  p: Principal,
  used: ModelSource,
  tokens: number | undefined,
  started: number,
) {
  const model = used.source === 'model';
  logAiCall(
    {
      source: used.source,
      model: model ? (used.model ?? String(env.ASSISTANT_MODEL)) : null,
      prompt: promptId('assistant'),
      ...(model ? {} : { fallback: String(env.AI_MODE) === 'mock' ? 'mock' : 'model unavailable' }),
    },
    Date.now() - started,
    { tokens: model ? (tokens ?? 0) : 0 },
  );
  if (model) await recordAssistantUsage(env, p, tokens);
}
