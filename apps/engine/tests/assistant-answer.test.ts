import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  type ModelMessage,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { answerStream, NUDGE } from '../src/assistant/answer';

type Reply = { think?: string; say?: string; call?: string };

const USAGE = {
  inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

/** A model that gives `replies` in order, one per step, and records each prompt it was sent. */
function scripted(replies: Reply[]) {
  const prompts: unknown[][] = [];
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not used')),
    async doStream(options) {
      prompts.push(options.prompt);
      const r = replies[prompts.length - 1] ?? {};
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (r.think)
        parts.push(
          { type: 'reasoning-start', id: 'r' },
          { type: 'reasoning-delta', id: 'r', delta: r.think },
          { type: 'reasoning-end', id: 'r' },
        );
      if (r.say)
        parts.push(
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: r.say },
          { type: 'text-end', id: 't' },
        );
      if (r.call)
        parts.push({
          type: 'tool-call',
          toolCallId: `c${prompts.length}`,
          toolName: r.call,
          input: '{}',
        });
      parts.push({
        type: 'finish',
        usage: USAGE,
        finishReason: { unified: r.call ? 'tool-calls' : 'stop', raw: undefined },
      });
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return { model, prompts };
}

const tools = {
  list_orders: tool({ inputSchema: z.object({}), execute: async () => ({ orders: 3 }) }),
};

async function turn(replies: Reply[], steps = 6) {
  const { model, prompts } = scripted(replies);
  let done = 0;
  let runs = 0;
  const asked: ModelMessage[] = [{ role: 'user', content: 'How many orders?' }];
  const stream = answerStream(
    (messages, budget) => {
      runs++;
      return streamText({ model, messages, tools, stopWhen: stepCountIs(budget) });
    },
    asked,
    { steps, metadata: () => ({ source: 'model' }), onDone: async () => void done++ },
  );
  let message: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) message = m;
  if (!message) throw new Error('no reply');
  return { message, prompts, done, runs };
}

const kinds = (parts: UIMessage['parts']) =>
  parts.filter((p) => p.type !== 'step-start').map((p) => p.type);

describe('a turn that stops without an answer', () => {
  it('asks once more, in the same reply, and the nudge stays out of it', async () => {
    const { message, prompts, done, runs } = await turn([
      { think: 'They want a count.' },
      { say: 'There are 3 orders.' },
    ]);
    expect(runs).toBe(2);
    expect(kinds(message.parts)).toEqual(['reasoning', 'text']);
    expect(message.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'There are 3 orders.' }),
    );
    expect(message.metadata).toEqual({ source: 'model' });
    expect(JSON.stringify(message)).not.toContain(NUDGE);
    expect(JSON.stringify(prompts[1])).toContain(NUDGE);
    expect(done).toBe(1);
  });

  it('asks again after tool steps, with what is left of the step budget', async () => {
    const { message, prompts, runs } = await turn(
      [{ call: 'list_orders' }, { think: 'Three.' }, { call: 'list_orders' }, { say: 'Three.' }],
      3,
    );
    expect(runs).toBe(2);
    // 3 steps in all: the first try took 2, so the second gets 1 and stops after its tool call.
    expect(prompts).toHaveLength(3);
    expect(kinds(message.parts)).toEqual(['tool-list_orders', 'reasoning', 'tool-list_orders']);
  });

  it('asks only once', async () => {
    const { message, runs, done } = await turn([{ think: 'Hmm.' }, { think: 'Still thinking.' }]);
    expect(runs).toBe(2);
    expect(kinds(message.parts)).toEqual(['reasoning', 'reasoning']);
    expect(done).toBe(1);
  });

  it('leaves an answered turn alone', async () => {
    const { message, runs, done } = await turn([{ think: 'Easy.', say: 'Three.' }]);
    expect(runs).toBe(1);
    expect(kinds(message.parts)).toEqual(['reasoning', 'text']);
    expect(message.metadata).toEqual({ source: 'model' });
    expect(done).toBe(1);
  });

  it("doesn't ask again when the step budget is spent", async () => {
    const { runs } = await turn([{ call: 'list_orders' }, { think: 'Done.' }], 2);
    expect(runs).toBe(1);
  });
});
