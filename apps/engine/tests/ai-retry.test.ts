import { env } from 'cloudflare:workers';
import type { FlowNode, Order, RunContext } from '@orderloop/core';
import { describe, expect, it, vi } from 'vitest';
import { runJson } from '../src/ai';
import { assess } from '../src/clef';
import { EXECUTORS, type ExecInput } from '../src/nodes';

/** The deployment's request-log setting, which every gateway call sends as `collectLog`. */
const LOGS = String(env.AI_GATEWAY_LOGS) === 'true';

/**
 * What happens when the model fails inside an order step: the step retries while it has attempts
 * left, the last attempt answers with the heuristic, and the risk and router nodes treat a
 * heuristic answer outside mock mode as unchecked (they fail closed). Mock mode is unchanged.
 */

type Call = { model: string; input: Record<string, unknown>; options: unknown };

/** The env with a model that does `reply` (as Workers AI would), instead of mock mode. */
function model(reply: () => unknown, over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const e = {
    ...env,
    AI_MODE: 'model',
    AI_GATEWAY_ID: '',
    ...over,
    AI: {
      run: async (model: string, input: Record<string, unknown>, options: unknown) => {
        calls.push({ model, input, options });
        return reply();
      },
    },
  } as unknown as Env;
  return { env: e, calls };
}
const down = () =>
  model(() => {
    throw new Error('3040: Capacity temporarily exceeded');
  });

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const ask = (e: Env, call: { retry?: boolean; orderId?: string } = {}) =>
  runJson(e, 'risk', [], schema, () => ({ ok: false }), call);

const order: Order = {
  id: 'ord_retry',
  createdAt: 0,
  model: 'b2b',
  channel: 'manual',
  customerId: 'cus_northwind',
  currency: 'USD',
  lines: [{ sku: 'WID-100', name: 'Widget', qty: 2, unitPrice: 50 }],
  subtotal: 100,
  shipping: 0,
  tax: 0,
  total: 100,
  meta: {},
};

function run(type: string, e: Env, config: Record<string, unknown>, retriesLeft?: boolean) {
  const node = { id: 'n', type, label: type, config, position: { x: 0, y: 0 } } as FlowNode;
  const ctx: RunContext = { order, nodes: {}, vars: {}, input: {}, now: 0, ref: 'R-1' };
  const i: ExecInput = { env: e, node, config, ctx, stepKey: 'n#1', retriesLeft };
  return EXECUTORS[type]!(i);
}

describe('model calls in an order step', () => {
  it('throw while the step has attempts left, and fall back on the last', async () => {
    await expect(ask(down().env, { retry: true })).rejects.toThrow(
      /model call failed \(3040: Capacity temporarily exceeded\); trying again/,
    );
    expect(await ask(down().env, { retry: false })).toMatchObject({
      source: 'heuristic',
      fallback: '3040: Capacity temporarily exceeded',
      value: { ok: false },
    });
    // Outside a step (copilot, drafts, MCP) there is no retry: the fallback is immediate.
    expect(await ask(down().env)).toMatchObject({ source: 'heuristic' });
  });

  it('retry a timeout, but not a bad answer: the same prompt would get the same one', async () => {
    const slow = model(() => new Promise(() => {}));
    await expect(
      runJson(slow.env, 'risk', [], schema, () => ({ ok: false }), { retry: true, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
    const wrong = model(() => ({ response: { ok: 'yes' } }));
    expect(await ask(wrong.env, { retry: true })).toMatchObject({
      source: 'heuristic',
      fallback: 'response does not match the schema',
    });
  });

  it('read a chat-completions answer, its tokens, and an answer cut off at max_tokens', async () => {
    const chat = (finish: string, content: string) =>
      model(() => ({
        choices: [{ message: { content }, finish_reason: finish }],
        usage: { total_tokens: 42 },
      })).env;
    expect(await ask(chat('stop', '{"ok":true}'))).toMatchObject({
      source: 'model',
      value: { ok: true },
      tokens: 42,
    });
    expect(await ask(chat('length', '{"ok":tr'))).toMatchObject({
      source: 'heuristic',
      fallback: 'the answer ran past max_tokens',
      tokens: 42,
    });
  });

  it('tag the gateway log with the prompt and order, keep no payload, and nothing personal', async () => {
    const m = model(() => ({ response: { ok: true } }), { AI_GATEWAY_ID: 'gw' });
    await ask(m.env, { orderId: 'ord_1' });
    expect(m.calls[0]!.options).toEqual({
      gateway: { id: 'gw', collectLog: LOGS, metadata: { prompt: 'risk@1', orderId: 'ord_1' } },
      extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
    });
    const a = model(() => ({ answers: {} }), { AI_GATEWAY_ID: 'gw' });
    await assess(a.env, { state: {}, questions: {} }, { orderId: 'ord_2' });
    expect(a.calls[0]!.options).toMatchObject({ gateway: { metadata: { orderId: 'ord_2' } } });
    // Without a gateway the call goes straight to Workers AI.
    const direct = model(() => ({ response: { ok: true } }));
    await ask(direct.env, { orderId: 'ord_1' });
    expect(direct.calls[0]!.options).toBeUndefined();
  });

  it('report a failed call as an error, one message per prompt, but not mock mode', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await ask(down().env);
      await ask(model(() => ({ response: 'not json' })).env);
      expect(errors.mock.calls.map(([e]) => (e as Error).message)).toEqual([
        'risk@1 answered from the heuristic: the model failed',
        'risk@1 answered from the heuristic: the model failed',
      ]);
      errors.mockClear();
      await ask(model(() => ({ response: { ok: true } })).env);
      await ask(model(() => ({ response: { ok: true } }), { AI_MODE: 'mock' }).env);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('Assess retries too', async () => {
    const questions = {
      fit: {
        type: 'choice' as const,
        instructions: 'Does it fit?',
        criteria: { yes: 'fits', no: 'does not' },
      },
    };
    await expect(assess(down().env, { state: {}, questions }, { retry: true })).rejects.toThrow(
      /trying again/,
    );
    expect(await assess(down().env, { state: {}, questions })).toMatchObject({
      source: 'heuristic',
    });
  });
});

describe('risk and router fail closed without the model', () => {
  it('risk retries, then takes the high branch on the last attempt', async () => {
    await expect(run('ai.risk_score', down().env, { threshold: 70 }, true)).rejects.toThrow(
      /trying again/,
    );
    const r = await run('ai.risk_score', down().env, { threshold: 70 }, false);
    expect(r.branches).toEqual(['high']);
    expect(r.vars).toEqual({ risk: 70 });
    expect(r.output).toMatchObject({ unchecked: true, source: 'heuristic' });
    expect(r.summary).toMatch(/not checked: the model was unavailable/);
  });

  it('risk takes the high branch on a bad answer too', async () => {
    const bad = model(() => ({ response: { score: 'low' } })).env;
    const r = await run('ai.risk_score', bad, {}, true);
    expect(r.branches).toEqual(['high']);
  });

  it('router sends the order to approval, or keeps the heuristic’s route without one', async () => {
    const routes = ['auto_approve', 'needs_approval'];
    await expect(run('ai.router', down().env, { routes }, true)).rejects.toThrow(/trying again/);
    const r = await run('ai.router', down().env, { routes }, false);
    expect(r.branches).toEqual(['needs_approval']);
    expect(r.output).toMatchObject({
      route: 'needs_approval',
      reason: 'The model was unavailable, so this order goes to approval.',
      unchecked: true,
    });
    expect(r.summary).toBe('→ needs_approval (model unavailable)');

    const other = await run('ai.router', down().env, { routes: ['ship', 'hold'] }, false);
    expect(other.branches).toEqual(['ship']);
    expect(other.summary).toBe('→ ship (model unavailable)');
  });

  it('mock mode answers as before: a small order from a known customer passes', async () => {
    expect(String(env.AI_MODE)).toBe('mock');
    const risk = await run('ai.risk_score', env, { threshold: 70 }, true);
    expect(risk.branches).toEqual(['low']);
    expect(risk.vars).toEqual({ risk: 10 });
    expect(risk.output).not.toHaveProperty('unchecked');
    const router = await run(
      'ai.router',
      env,
      { routes: ['auto_approve', 'needs_approval'] },
      true,
    );
    expect(router.branches).toEqual(['auto_approve']);
    expect(router.summary).toBe('→ auto_approve');
  });
});
