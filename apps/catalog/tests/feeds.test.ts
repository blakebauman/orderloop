import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { FeedStatus } from '@orderloop/core/product';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { storeStream, UploadStalled } from '../src/upload';
import { api, by, doc, product, settle, setup } from './helpers';

beforeAll(setup);

// A feed that can't be read fails its `read header` step, which Workflows retry with growing
// delays (about 30s in all) before the `fail` step records it. Tests that expect that failure
// call `failFast()`: retries still happen, without the waits.
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
async function failFast() {
  introspector = await introspectWorkflow(env.FEED_IMPORT);
  await introspector.modifyAll(async (m) => {
    await m.disableRetryDelays();
  });
}
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

function body(text: string, chunk = 4096): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

async function finished(id: string): Promise<FeedStatus> {
  for (let i = 0; i < 300; i++) {
    const s = await api.feedStatus(id);
    if (s && s.state !== 'queued' && s.state !== 'splitting' && s.state !== 'applying') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`feed ${id} never finished: ${JSON.stringify(await api.feedStatus(id))}`);
}

/** A CSV of `n` products with two variant rows each; rows named in `bad` get a bad material. */
function csv(prefix: string, n: number, bad: number[] = []) {
  const lines = ['key,type,title:en,title:fr,categories,price.web,sku,attr.material,attr.size'];
  for (let i = 0; i < n; i++) {
    const material = bad.includes(i) ? 'silk' : 'cotton';
    lines.push(
      `${prefix}-${i},apparel,"Tee, no. ${i}",T-shirt ${i},tees,19.99,${prefix}-${i}-S,${material},S`,
    );
    lines.push(`${prefix}-${i},,,,,,${prefix}-${i}-M,,M`);
  }
  return lines.join('\r\n');
}

describe('feeds', () => {
  it('imports a CSV feed across several steps, reporting rejected rows by number', async () => {
    // 650 products with FEED_CHUNK 300 is three split steps. What costs time is parts, not rows
    // (every chunk sends a part to nearly all 64 shards, each a queue message and a shard call),
    // and the file is imported twice: 1,000 products was 500 parts, which a busy CI runner took
    // past the 60s limit.
    const N = 650;
    const prefix = `csv${Date.now().toString(36)}`;
    const started = await api.startFeed(body(csv(prefix, N, [10, 500])), {
      name: 'supplier.csv',
      format: 'csv',
      by,
    });
    expect(started).toMatchObject({ state: 'queued', format: 'csv', name: 'supplier.csv' });
    const s = await finished(started.id);
    expect(s).toMatchObject({ state: 'done', rows: N, created: N - 2, rejected: 2, updated: 0 });
    expect(s.parts).toBe(s.partsDone);
    // Product 10 starts on row 22 (a header, then two rows per product).
    expect(s.errors.map((e) => [e.row, e.key])).toEqual([
      [22, `${prefix}-10`],
      [1002, `${prefix}-500`],
    ]);
    expect(s.errors[0]?.message).toContain('attributes.material');

    expect(await api.getProduct(`${prefix}-${N - 1}`)).toMatchObject({
      title: { en: `Tee, no. ${N - 1}`, fr: `T-shirt ${N - 1}` },
      variants: [{ sku: `${prefix}-${N - 1}-S` }, { sku: `${prefix}-${N - 1}-M` }],
    });
    await settle();
    expect(await doc(`${prefix}-0`)).toMatchObject({ title: 'Tee, no. 0' });

    // The same file again changes nothing.
    const again = await finished(
      (
        await api.startFeed(body(csv(prefix, N, [10, 500])), {
          name: 'again',
          format: 'csv',
          by,
        })
      ).id,
    );
    expect(again).toMatchObject({
      state: 'done',
      created: 0,
      updated: 0,
      unchanged: N - 2,
      rejected: 2,
    });
    expect((await api.listFeeds(2)).map((f) => f.id)).toEqual([again.id, started.id]);
  });

  it('imports NDJSON and reports a shard-level refusal with its line', async () => {
    const prefix = `nd${Date.now().toString(36)}`;
    const product = (i: number, sku = `${prefix}-${i}-S`) =>
      JSON.stringify({
        key: `${prefix}-${i}`,
        type: 'apparel',
        title: { en: `P ${i}` },
        attributes: { material: 'wool' },
        variants: [{ sku, attributes: { size: 'S' } }],
        channels: { web: { visible: true, price: { amount: 500, currency: 'USD' } } },
      });
    // Line 3 reuses line 1's SKU (whichever shard applies first keeps it); line 4 isn't JSON.
    const text = [product(1), product(2), product(3, `${prefix}-1-S`), '{oops', product(5)].join(
      '\n',
    );
    const s = await finished(
      (await api.startFeed(body(text, 7), { name: 'x.ndjson', format: 'ndjson', by })).id,
    );
    expect(s).toMatchObject({ state: 'done', rows: 5, created: 3, rejected: 2 });
    const [conflict, json] = s.errors;
    expect([1, 3]).toContain(conflict?.row);
    expect(conflict).toMatchObject({
      key: `${prefix}-${conflict?.row}`,
      message: expect.stringContaining('already used'),
    });
    expect(json).toEqual({ row: 4, message: 'invalid JSON' });
  });

  it('cancels a feed that never started, and leaves a finished one as it is', async () => {
    // A feed whose record exists but whose Workflow never started: nothing would ever move it.
    const { feeds } = await import('../src/config');
    const id = `feed_orphan${Date.now().toString(36)}`;
    await feeds(env).create({ id, name: 'stuck', format: 'csv', by });
    const s = await api.cancelFeed(id, by);
    expect(s).toMatchObject({ state: 'cancelled', cancelledBy: by });
    expect(s?.finishedAt).toBeTypeOf('number');
    // Final: a late split or finish changes nothing, and a second cancel is a no-op.
    await feeds(env).splitDone(id);
    await feeds(env).finish(id);
    expect((await api.feedStatus(id))?.state).toBe('cancelled');
    expect((await api.cancelFeed(id, by))?.state).toBe('cancelled');
    expect(await api.cancelFeed('feed_none', by)).toBeNull();

    await failFast();
    const failed = await finished(
      (await api.startFeed(body('name,price\nx,1'), { name: 'bad', format: 'csv', by })).id,
    );
    expect(failed.state).toBe('failed');
    expect((await api.cancelFeed(failed.id, by))?.state).toBe('failed');
  });

  it('stops a running feed when it is cancelled', async () => {
    const prefix = `cxl${Date.now().toString(36)}`;
    const started = await api.startFeed(body(csv(prefix, 1_000)), {
      name: 'big.csv',
      format: 'csv',
      by,
    });
    expect((await api.cancelFeed(started.id, by))?.state).toBe('cancelled');
    const instance = await env.FEED_IMPORT.get(started.id);
    const stopped = ['terminated', 'complete', 'errored'];
    for (let i = 0; i < 100 && !stopped.includes((await instance.status()).status); i++)
      await scheduler.wait(50);
    expect(['terminated', 'complete']).toContain((await instance.status()).status);
    // Nothing reached afterwards moves it: no split or finish overwrote the state.
    expect((await api.feedStatus(started.id))?.state).toBe('cancelled');
  });

  it('fails a feed whose file has no header it can use', async () => {
    await failFast();
    const s = await finished(
      (await api.startFeed(body('name,price\nx,1'), { name: 'bad', format: 'csv', by })).id,
    );
    expect(s).toMatchObject({
      state: 'failed',
      failure: expect.stringContaining('"key" and "sku"'),
    });
  });
});

describe('storing streams', () => {
  it('stores a stream over one part as a multipart upload', async () => {
    const big = 'x'.repeat(10 * 1024 * 1024 + 123);
    expect(await storeStream(env.PUBLISHED, 'test/big', body(big, 1024 * 1024))).toBe(big.length);
    expect((await env.PUBLISHED.head('test/big'))?.size).toBe(big.length);
  });

  it('gives up on a stream that stops sending, storing nothing', async () => {
    // A part's worth arrives (so a multipart upload has begun), then nothing, never closed.
    const part = new Uint8Array(10 * 1024 * 1024 + 1);
    let sent = false;
    let cancelled: unknown;
    const stalled = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) c.enqueue(part);
        sent = true;
        return new Promise(() => {});
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    await expect(storeStream(env.PUBLISHED, 'test/stalled', stalled, 200)).rejects.toThrow(
      'upload stalled',
    );
    expect(cancelled).toBeInstanceOf(UploadStalled);
    expect(await env.PUBLISHED.head('test/stalled')).toBeNull();
    const pending = await env.PUBLISHED.list({ prefix: 'test/stalled', include: [] });
    expect(pending.objects).toEqual([]);
  });
  it("fails a stored feed whose import can't start instead of leaving it queued", async () => {
    const create = vi
      .spyOn(env.FEED_IMPORT, 'create')
      .mockRejectedValueOnce(new Error('too many instances'));
    try {
      // Settled with then: expect().rejects would read properties off the RPC promise, and each
      // read pipelines another call that rejects unhandled.
      const err = await api
        .startFeed(body('name,price\nx,1'), { name: 'orphan', format: 'csv', by })
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(err?.message).toContain('too many instances');
    } finally {
      create.mockRestore();
    }
    const feed = (await api.listFeeds(100)).find((f) => f.name === 'orphan');
    expect(feed?.state).toBe('failed');
  });
});

describe('reindex', () => {
  it('queues every product on every shard for publishing', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    await env.PUBLISHED.delete(`docs/f1/web/en/p/${p.key}.json`);
    const { queued } = await api.reindex(by);
    expect(queued).toBeGreaterThanOrEqual(1);
    await settle();
    // Republished: the document is back.
    expect(await doc(p.key)).toMatchObject({ key: p.key });
  });
});
