import { describe, expect, it } from 'vitest';
import {
  AI_PROMPTS,
  ASSISTANT_DAILY_TOKENS,
  assistantDailyTokens,
  promptId,
  usageDay,
} from '../src/provenance';

describe('AI provenance', () => {
  it('names each prompt with its version', () => {
    expect(promptId('extract')).toBe(`extract@${AI_PROMPTS.extract}`);
  });

  it('budgets a million assistant tokens a day unless set; 0 is no limit', () => {
    expect(assistantDailyTokens(undefined)).toBe(ASSISTANT_DAILY_TOKENS);
    expect(assistantDailyTokens('250000')).toBe(250_000);
    expect(assistantDailyTokens('0')).toBe(Number.POSITIVE_INFINITY);
    expect(assistantDailyTokens('-5')).toBe(ASSISTANT_DAILY_TOKENS);
    expect(usageDay(Date.UTC(2026, 9, 17, 23, 59))).toBe('2026-10-17');
  });
});
