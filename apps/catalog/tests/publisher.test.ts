import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { publisherOf, runOps } from '../src/publisher';

describe('publishers', () => {
  it('sends a key to the same publisher every time, and spreads keys over all of them', () => {
    // The same publisher is what keeps one product's writes in order.
    expect(publisherOf('tee-classic', 8)).toBe(publisherOf('tee-classic', 8));
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 8_000; i++) {
      const p = publisherOf(`p-${i}`, 8);
      counts[p] = (counts[p] ?? 0) + 1;
    }
    for (const c of counts) expect(Math.abs(c - 1_000)).toBeLessThan(150);
    expect(publisherOf('anything', 1)).toBe(0);
  });

  it('runs puts and deletes against R2 and KV', async () => {
    await runOps(env, [
      {
        put: 'r2',
        key: 'test/pub/a.json',
        body: '{"a":1}',
        contentType: 'application/json',
        version: '3',
      },
      { put: 'kv', key: 'test:pub:a', value: 'card' },
    ]);
    const a = await env.PUBLISHED.get('test/pub/a.json');
    expect(await a?.text()).toBe('{"a":1}');
    expect(a?.customMetadata).toEqual({ version: '3' });
    expect(a?.httpMetadata?.contentType).toBe('application/json');
    expect(await env.CARDS.get('test:pub:a')).toBe('card');
    await runOps(env, [
      { delete: 'r2', keys: ['test/pub/a.json'] },
      { delete: 'kv', key: 'test:pub:a' },
    ]);
    expect(await env.PUBLISHED.head('test/pub/a.json')).toBeNull();
    expect(await env.CARDS.get('test:pub:a')).toBeNull();
  });
});
