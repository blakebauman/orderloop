import { describe, expect, it } from 'vitest';
import type { OrderState } from '../src/api';
import {
  AI_PROMPTS,
  ASSISTANT_DAILY_TOKENS,
  aiGateFeedback,
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

describe('aiGateFeedback', () => {
  const model = { source: 'model', model: 'm', prompt: 'risk@1', logId: 'log_1' };
  /** risk → (high) → trust → (escalated) → owner; risk → (low) → ship. */
  const state = (riskOutput: Record<string, unknown>, branch = 'high', trust?: string) =>
    ({
      orderId: 'ord_1',
      flow: {
        nodes: [
          { id: 'risk', type: 'ai.risk_score' },
          { id: 'credit', type: 'commerce.credit_check' },
          { id: 'trust', type: 'control.approval' },
          { id: 'owner', type: 'control.approval' },
        ],
        edges: [
          { id: 'e1', source: 'risk', target: 'trust', sourceHandle: 'high' },
          { id: 'e2', source: 'credit', target: 'trust', sourceHandle: 'over_limit' },
          { id: 'e3', source: 'trust', target: 'owner', sourceHandle: 'escalated' },
        ],
      },
      nodes: {
        risk: { status: 'succeeded', runs: 1, branches: [branch], output: riskOutput },
        credit: { status: 'succeeded', runs: 1, branches: ['ok'] },
        ...(trust ? { trust: { status: 'succeeded', runs: 1, branches: [trust] } } : {}),
      },
    }) as unknown as OrderState;

  it('marks the gate that sent the order: rejected was right, approved was not needed', () => {
    expect(aiGateFeedback(state(model), 'trust', 'rejected')).toEqual({
      nodeId: 'risk',
      prompt: 'risk@1',
      logId: 'log_1',
      feedback: 1,
    });
    expect(aiGateFeedback(state(model), 'trust', 'approved')?.feedback).toBe(-1);
  });

  it('follows an escalation from an earlier approval back to the gate', () => {
    expect(aiGateFeedback(state(model, 'high', 'escalated'), 'owner', 'approved')).toMatchObject({
      nodeId: 'risk',
      feedback: -1,
    });
  });

  it('marks nothing for the heuristic, a call without a log entry, or a branch not taken', () => {
    expect(
      aiGateFeedback(state({ ...model, source: 'heuristic' }), 'trust', 'rejected'),
    ).toBeNull();
    expect(aiGateFeedback(state({ ...model, unchecked: true }), 'trust', 'rejected')).toBeNull();
    expect(aiGateFeedback(state({ ...model, logId: undefined }), 'trust', 'rejected')).toBeNull();
    expect(aiGateFeedback(state(model, 'low'), 'trust', 'rejected')).toBeNull();
    expect(aiGateFeedback({ ...state(model), flow: null }, 'trust', 'rejected')).toBeNull();
  });
});
