import { describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};
vi.mock('cloudflare:workers', () => ({ env }));

const { overBudget } = await import('~/lib/rate-limit');

describe('per-caller budgets', () => {
  it('lets a caller through while its budget lasts, then answers 429 with Retry-After', async () => {
    const used = new Map<string, number>();
    env.API_LIMIT = {
      limit: async ({ key }: { key: string }) => {
        used.set(key, (used.get(key) ?? 0) + 1);
        return { success: used.get(key)! <= 2 };
      },
    };
    expect(await overBudget('API_LIMIT', 'tok_a')).toBeNull();
    expect(await overBudget('API_LIMIT', 'tok_a')).toBeNull();
    const refused = await overBudget('API_LIMIT', 'tok_a');
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('60');
    expect(await refused?.json()).toEqual({ error: 'Too many requests; try again in 60 seconds.' });
    // Another caller has its own budget.
    expect(await overBudget('API_LIMIT', 'tok_b')).toBeNull();
  });

  it('limits nothing without the binding', async () => {
    expect(await overBudget('AGENT_LIMIT', '/mcp:usr_a')).toBeNull();
  });
});
