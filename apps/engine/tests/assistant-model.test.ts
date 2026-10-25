import { generateText, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_FALLBACK_MODEL,
  assistantGateway,
  assistantModel,
  type ModelSource,
  type Turn,
} from '../src/assistant/model';

/**
 * The live path with a stand-in AI binding: createAI calls `run(model, input, options)` and reads a
 * chat-completions body back. `answers` maps a model to its reply, or to a status it fails with.
 */
function fakeAi(answers: Record<string, string | number>) {
  const calls: { model: string; options: Record<string, unknown> }[] = [];
  const binding = {
    aiGatewayLogId: null,
    async run(model: string, _input: unknown, options: Record<string, unknown>) {
      calls.push({ model, options });
      const answer = answers[model] ?? 503;
      if (typeof answer === 'number')
        return Response.json({ errors: [{ message: 'unavailable' }] }, { status: answer });
      return Response.json({
        choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    },
    fetch: () => Promise.reject(new Error('not used')),
  };
  return { binding, calls };
}

const PRIMARY = '@cf/moonshotai/kimi-k2.6';
const turn: Turn = { surface: 'panel', principalId: 'usr_alice', conversation: 'usr_alice' };

function liveEnv(ai: unknown, gateway = 'orderloop') {
  return { AI: ai, AI_MODE: 'live', AI_GATEWAY_ID: gateway, ASSISTANT_MODEL: PRIMARY } as never;
}

const headersOf = (o: Record<string, unknown>) => (o.extraHeaders ?? {}) as Record<string, string>;
const gatewayOf = (o: Record<string, unknown>) => o.gateway as Record<string, unknown>;

describe('assistant gateway options', () => {
  it('tags a turn without personal data, retries, and keeps payloads out of the log', async () => {
    const a = await assistantGateway(liveEnv(null), turn);
    const b = await assistantGateway(liveEnv(null), turn);
    expect(a.gateway).toMatchObject({
      id: 'orderloop',
      retries: { maxAttempts: 3, backoff: 'exponential' },
      requestTimeoutMs: 20_000,
    });
    expect(a.gateway.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.gateway.eventId).not.toBe(a.gateway.eventId);
    const metadata = a.gateway.metadata ?? {};
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(5);
    expect(metadata).toMatchObject({
      prompt: expect.stringMatching(/^assistant@/),
      surface: 'panel',
    });
    expect(metadata.principal).toMatch(/^[0-9a-f]{16}$/);
    expect(metadata.principal).toBe(b.gateway.metadata?.principal);
    expect(JSON.stringify(a)).not.toContain('alice');
    expect(a.headers).toEqual({ 'cf-aig-collect-log-payload': 'false' });
  });

  it('sends no gateway options when there is no gateway', async () => {
    expect(await assistantGateway(liveEnv(null, ''), turn)).toEqual({
      gateway: { id: '' },
      headers: {},
    });
  });
});

describe('assistant model chain', () => {
  const prompt = 'What needs me?';

  it('answers with the assistant model, through the gateway, on one replica per conversation', async () => {
    const { binding, calls } = fakeAi({ [PRIMARY]: 'All clear.' });
    const used: ModelSource = { source: 'model' };
    const result = streamText({
      model: await assistantModel(liveEnv(binding), { kind: 'workspace' }, used, turn),
      prompt,
    });
    expect(await result.text).toBe('All clear.');
    expect(used).toEqual({ source: 'model', model: PRIMARY });
    expect(calls.map((c) => c.model)).toEqual([PRIMARY]);
    const options = calls[0]!.options;
    expect(gatewayOf(options)).toMatchObject({ id: 'orderloop', requestTimeoutMs: 20_000 });
    const headers = headersOf(options);
    expect(headers['cf-aig-collect-log-payload']).toBe('false');
    expect(headers['x-session-affinity']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(options)).not.toContain('alice');
  });

  it('tries the fallback model before the heuristic, in the same gateway event', async () => {
    const { binding, calls } = fakeAi({ [PRIMARY]: 503, [ASSISTANT_FALLBACK_MODEL]: 'From GLM.' });
    const used: ModelSource = { source: 'model' };
    const result = await generateText({
      model: await assistantModel(liveEnv(binding), { kind: 'workspace' }, used, turn),
      prompt,
    });
    expect(result.text).toBe('From GLM.');
    expect(used).toEqual({ source: 'model', model: ASSISTANT_FALLBACK_MODEL });
    expect(calls.map((c) => c.model)).toEqual([PRIMARY, ASSISTANT_FALLBACK_MODEL]);
    const [first, second] = calls.map((c) => gatewayOf(c.options));
    expect(second!.eventId).toBe(first!.eventId);
    expect(headersOf(calls[1]!.options)['x-session-affinity']).toBe(
      headersOf(calls[0]!.options)['x-session-affinity'],
    );
  });

  it('streams the fallback model’s answer and names it', async () => {
    const { binding } = fakeAi({ [PRIMARY]: 500, [ASSISTANT_FALLBACK_MODEL]: 'Streamed.' });
    const used: ModelSource = { source: 'model' };
    const result = streamText({
      model: await assistantModel(liveEnv(binding), { kind: 'workspace' }, used, turn),
      prompt,
    });
    expect(await result.text).toBe('Streamed.');
    expect(used).toEqual({ source: 'model', model: ASSISTANT_FALLBACK_MODEL });
  });

  it('lets the heuristic answer when both models fail', async () => {
    const { binding, calls } = fakeAi({});
    for (const run of ['generate', 'stream'] as const) {
      const used: ModelSource = { source: 'model' };
      const model = await assistantModel(liveEnv(binding), { kind: 'workspace' }, used, turn);
      const text =
        run === 'generate'
          ? (await generateText({ model, prompt: 'hello' })).text
          : await streamText({ model, prompt: 'hello' }).text;
      expect(text).toContain('without the language model');
      expect(used.source).toBe('heuristic');
    }
    expect(calls.filter((c) => c.model === ASSISTANT_FALLBACK_MODEL)).toHaveLength(2);
  });

  it('calls Workers AI directly when there is no gateway', async () => {
    const { binding, calls } = fakeAi({ [PRIMARY]: 'Direct.' });
    const used: ModelSource = { source: 'model' };
    const result = await generateText({
      model: await assistantModel(liveEnv(binding, ''), { kind: 'workspace' }, used, turn),
      prompt,
    });
    expect(result.text).toBe('Direct.');
    // The binding goes to Workers AI's own /run only for an empty gateway id.
    expect(gatewayOf(calls[0]!.options)).toEqual({ id: '' });
    const headers = headersOf(calls[0]!.options);
    expect(headers['cf-aig-collect-log-payload']).toBeUndefined();
    expect(headers['x-session-affinity']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the heuristic in mock mode, without touching the binding', async () => {
    const { binding, calls } = fakeAi({ [PRIMARY]: 'never' });
    const used: ModelSource = { source: 'model' };
    const env = { ...(liveEnv(binding) as object), AI_MODE: 'mock' } as never;
    await generateText({
      model: await assistantModel(env, { kind: 'workspace' }, used, turn),
      prompt,
    });
    expect(used.source).toBe('heuristic');
    expect(calls).toHaveLength(0);
  });
});
