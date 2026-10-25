import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { backoff } from '../src';
import { deadLetterKey, isDeadLetterQueue, keepDeadLetters } from '../src/dead-letters';

const sent = new Date(Date.UTC(2026, 9, 24, 23, 59));

/** Runs the Worker's queue handler on a batch and notes each retry's delay (the local queue doesn't). */
async function consume(
  queue: string,
  messages: { id: string; attempts: number; body: unknown }[],
  handle: (batch: MessageBatch) => Promise<void> = (b) => worker.queue(b, env),
) {
  const batch = createMessageBatch(
    queue,
    messages.map((m) => ({ ...m, timestamp: sent })),
  );
  const delays: Record<string, number | undefined> = {};
  for (const m of batch.messages) {
    const retry = m.retry.bind(m);
    vi.spyOn(m, 'retry').mockImplementation((o) => {
      delays[m.id] = o?.delaySeconds;
      retry(o);
    });
  }
  await handle(batch);
  return { delays, result: await getQueueResult(batch, createExecutionContext()) };
}

afterEach(() => vi.restoreAllMocks());

describe('backoff', () => {
  it('doubles from the base with each delivery, up to the cap', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoff(a, 10, 300))).toEqual([10, 20, 40, 80, 160]);
    expect(backoff(11, 5, 900)).toBe(900);
    expect(backoff(0, 5, 900)).toBe(5);
  });
});

describe('listing changes', () => {
  it('retries every message of a failed batch, each backing off by its own attempts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A null change fails the batch before any listing, search shard or row is touched.
    const { delays, result } = await consume('orderloop-catalog-changes-acme', [
      { id: 'a', attempts: 1, body: [null] },
      { id: 'b', attempts: 4, body: [] },
      { id: 'c', attempts: 10, body: [] },
    ]);
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryBatch.retry).toBe(false);
    expect(delays).toEqual({ a: 5, b: 40, c: 900 });
    expect(errors).toHaveBeenCalled();
  });

  it('acknowledges a batch that applies', async () => {
    const { result } = await consume('orderloop-catalog-changes-acme', [
      { id: 'a', attempts: 2, body: [] },
    ]);
    expect(result.ackAll).toBe(true);
    expect(result.retryMessages).toEqual([]);
  });
});

describe('dead letters', () => {
  it('tells the dead-letter queues from theirs, with or without a suffix', () => {
    for (const q of ['orderloop-catalog-changes-dlq', 'orderloop-catalog-purge-dlq-acme'])
      expect(isDeadLetterQueue(q)).toBe(true);
    expect(isDeadLetterQueue('orderloop-catalog-feed-parts-dlq-eu-1')).toBe(true);
    for (const q of [
      'orderloop-catalog-changes',
      'orderloop-catalog-changes-acme',
      // A deployment whose id starts with "dlq".
      'orderloop-catalog-changes-dlqcorp',
    ])
      expect(isDeadLetterQueue(q)).toBe(false);
  });

  it('keeps each dead letter in R2, logs one line for alerting, then acknowledges it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = 'orderloop-catalog-changes-dlq-acme';
    const body = [{ key: 'tee', channel: 'web', at: 1 }];
    const { result } = await consume(queue, [{ id: 'm1', attempts: 2, body }]);
    expect(result.explicitAcks).toEqual(['m1']);
    expect(result.retryMessages).toEqual([]);

    const key = `dlq/${queue}/2026-10-24/m1.json`;
    const kept = await env.PUBLISHED.get(key);
    expect(await kept?.json()).toEqual({
      queue,
      id: 'm1',
      timestamp: sent.toISOString(),
      attempts: 2,
      body,
    });
    // Error level, so Workers Observability counts it; the body stays out of the logs.
    const lines = errors.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(JSON.stringify({ type: 'dlq_message', queue, id: 'm1', attempts: 2 }));
    expect(lines.join('\n')).not.toContain('tee');
  });

  it('overwrites the same object when a dead letter is delivered twice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = 'orderloop-catalog-purge-dlq-acme';
    await consume(queue, [{ id: 'p1', attempts: 1, body: { tags: ['p:a'] } }]);
    await consume(queue, [{ id: 'p1', attempts: 2, body: { tags: ['p:a'] } }]);
    const listed = await env.PUBLISHED.list({ prefix: `dlq/${queue}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([`dlq/${queue}/2026-10-24/p1.json`]);
  });

  it("retries, backing off, a dead letter it couldn't write, and doesn't log it as kept", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      put: async () => {
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;
    const queue = 'orderloop-catalog-feed-parts-dlq-acme';
    const { delays, result } = await consume(
      queue,
      [
        { id: 'f1', attempts: 1, body: {} },
        { id: 'f2', attempts: 3, body: {} },
      ],
      (b) => keepDeadLetters(b, failing, (a) => backoff(a, 30, 900)),
    );
    expect(result.explicitAcks).toEqual([]);
    expect(delays).toEqual({ f1: 30, f2: 120 });
    expect(errors.mock.calls.some((c) => String(c[0]).includes('"dlq_message"'))).toBe(false);
  });

  it('keys a dead letter by the day it was sent', () => {
    const msg = { id: 'x', timestamp: sent } as Message;
    expect(deadLetterKey('q', msg)).toBe('dlq/q/2026-10-24/x.json');
  });
});
