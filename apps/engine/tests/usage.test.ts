import { env } from 'cloudflare:workers';
import type { Principal } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { assistantBudgetSpent, pruneUsage, recordAssistantUsage } from '../src/usage';

const p: Principal = { kind: 'user', id: 'usr_budget', name: 'budget', role: 'viewer' };
const withLimit = (n: string) => ({ ...env, ASSISTANT_DAILY_TOKENS: n }) as unknown as Env;

describe("the assistant's daily token budget", () => {
  it('adds up a day, refuses once spent, resets the next day, and is pruned after 90', async () => {
    const day = Date.UTC(2026, 9, 17, 12);
    const env100 = withLimit('100');
    expect(await assistantBudgetSpent(env100, p, day)).toBe(false);
    await recordAssistantUsage(env100, p, 60, day);
    expect(await assistantBudgetSpent(env100, p, day)).toBe(false);
    await recordAssistantUsage(env100, p, 45, day);
    expect(await assistantBudgetSpent(env100, p, day)).toBe(true);
    expect(await assistantBudgetSpent(withLimit('0'), p, day)).toBe(false);
    expect(await assistantBudgetSpent(env100, p, day + 86_400_000)).toBe(false);
    expect(await pruneUsage(env100, day + 91 * 86_400_000)).toBeGreaterThanOrEqual(1);
    expect(await assistantBudgetSpent(env100, p, day)).toBe(false);
  });
});
