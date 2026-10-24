/**
 * Feed import: a stored feed file becomes shard batches.
 *
 * The FeedImport Workflow reads the file in chunks of FEED_CHUNK products. Each chunk is one step:
 * a range read from where the last one stopped (always a product boundary), validation against the
 * catalog's types, then one part per shard written to R2 and one queue message per part. The step
 * returns the byte offset to resume from, so a feed of any size is many short steps, and a step that
 * fails is retried on its own. Part ids are `<chunk>-<shard>`, deterministic, and become the shard
 * batch id, so a retried step or a redelivered message never applies a row twice.
 *
 * The parts consumer (`applyPart`) applies each part on its shard and records it with CatalogFeeds;
 * the part that completes the feed wakes the Workflow, which then marks it done.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  csvHeader,
  csvProducts,
  csvRecords,
  FEED_CHUNK,
  type FeedFormat,
  type FeedRow,
  ndjsonRecords,
  type ProductData,
  type ProductInput,
  productShard,
  validateProduct,
} from '@orderloop/core/product';
import { feeds, meta, shard, typeResolver } from './config';
import type { FeedError, PartCounts } from './feeds';

export type FeedParams = { id: string; format: FeedFormat; key: string; by: string };

/** One queue message: a part of a feed for one shard. */
export type FeedPart = {
  feed: string;
  part: string;
  shard: number;
  key: string;
  rev: number;
  by: string;
};

type PartLine = { row: number; data: ProductData };

type Chunk = {
  /** Where the next chunk starts, and the row number it starts at. */
  offset: number;
  row: number;
  rows: number;
  parts: number;
  rejected: number;
  errors: FeedError[];
  done: boolean;
};

export const partKey = (feed: string, part: string) => `feeds/${feed}/parts/${part}.ndjson`;

/** Products from the file, starting at `offset` (a product boundary). */
async function* readProducts(
  env: Env,
  p: FeedParams,
  from: { offset: number; row: number; header?: string[] },
  resolve: ReturnType<typeof typeResolver>,
  channels: Parameters<typeof csvProducts>[2],
): AsyncGenerator<FeedRow, void, undefined> {
  const object = await env.PUBLISHED.get(p.key, { range: { offset: from.offset } });
  if (!object) throw new Error(`feed file ${p.key} is missing`);
  // Leaving either loop early (a full chunk) cancels the read: the parsers do it on return.
  if (p.format === 'csv')
    yield* csvProducts(csvRecords(object.body, from.offset), resolve, channels, {
      header: from.header,
      firstRow: from.row,
    });
  else
    for await (const r of ndjsonRecords(object.body, from.offset, from.row))
      yield r.error
        ? { row: r.line, last: r.line, error: r.error, end: r.end }
        : { row: r.line, last: r.line, product: r.value as ProductInput, end: r.end };
}

/** One split step: up to FEED_CHUNK products from `from`, sent to the shards as parts. */
export async function splitChunk(
  env: Env,
  p: FeedParams,
  chunk: number,
  from: { offset: number; row: number; header?: string[]; size: number },
): Promise<Chunk> {
  const out: Chunk = {
    offset: from.offset,
    row: from.row,
    rows: 0,
    parts: 0,
    rejected: 0,
    errors: [],
    done: true,
  };
  if (from.offset >= from.size) return out;
  const config = await meta(env).getConfig();
  const resolve = typeResolver(config);
  const channels = new Map(config.channels.map((c) => [c.code, c]));
  const buffers = new Map<number, PartLine[]>();
  const reject = (row: number, message: string, key?: string) => {
    out.rejected++;
    if (out.errors.length < 20) out.errors.push({ row, key, message });
  };

  let products = 0;
  for await (const r of readProducts(env, p, from, resolve, channels)) {
    out.rows++;
    out.offset = r.end;
    out.row = r.last + 1;
    if (r.error || !r.product) reject(r.row, r.error ?? 'empty row');
    else {
      const v = validateProduct(r.product, resolve);
      if (!v.ok)
        reject(r.row, v.issues.map((i) => `${i.path}: ${i.message}`).join('; '), r.product.key);
      else {
        const n = productShard(v.data.key);
        const list = buffers.get(n) ?? [];
        list.push({ row: r.row, data: v.data });
        buffers.set(n, list);
      }
    }
    if (++products >= (Number(env.FEED_CHUNK) || FEED_CHUNK)) {
      out.done = false;
      break;
    }
  }
  const messages: { body: FeedPart }[] = [];
  await Promise.all(
    [...buffers].map(async ([n, lines]) => {
      const part = `${chunk}-${n}`;
      const key = partKey(p.id, part);
      await env.PUBLISHED.put(key, lines.map((l) => JSON.stringify(l)).join('\n'));
      messages.push({ body: { feed: p.id, part, shard: n, key, rev: config.rev, by: p.by } });
    }),
  );
  for (let i = 0; i < messages.length; i += 100)
    await env.FEED_PARTS.sendBatch(messages.slice(i, i + 100));
  out.parts = messages.length;
  return out;
}

/** Applies one part on its shard and records it; wakes the Workflow when it finished the feed. */
export async function applyPart(env: Env, m: FeedPart): Promise<void> {
  const object = await env.PUBLISHED.get(m.key);
  if (!object) throw new Error(`part ${m.key} is missing`);
  const lines = (await object.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PartLine);
  const results = await shard(env, m.shard).apply({
    shard: m.shard,
    batchId: `${m.feed}:${m.part}`,
    rows: lines.map((l) => l.data),
    rev: m.rev,
    by: m.by,
  });
  const counts: PartCounts = { created: 0, updated: 0, unchanged: 0, rejected: 0 };
  const errors: FeedError[] = [];
  results.forEach((r, i) => {
    if (r.status === 'deleted') return;
    counts[r.status] += 1;
    if (r.status === 'rejected' && errors.length < 20)
      errors.push({
        row: (lines[i] as PartLine).row,
        key: r.key,
        message: (r.issues ?? []).map((x) => `${x.path}: ${x.message}`).join('; '),
      });
  });
  const { complete } = await feeds(env).partDone(m.feed, m.part, counts, errors);
  if (complete) await wake(env, m.feed);
}

/** Gives up on a part after its last retry: its rows count as rejected. */
export async function failPart(env: Env, m: FeedPart, error: unknown): Promise<void> {
  const object = await env.PUBLISHED.get(m.key);
  const lines = object ? (await object.text()).split('\n').filter(Boolean).length : 0;
  const message = `part ${m.part} failed: ${error instanceof Error ? error.message : String(error)}`;
  const { complete } = await feeds(env).partDone(
    m.feed,
    m.part,
    { created: 0, updated: 0, unchanged: 0, rejected: lines },
    [{ row: 0, message }],
  );
  if (complete) await wake(env, m.feed);
}

async function wake(env: Env, feed: string) {
  try {
    await (await env.FEED_IMPORT.get(feed)).sendEvent({ type: 'applied', payload: {} });
  } catch {
    // The Workflow also checks on its own every minute.
  }
}

export class FeedImport extends WorkflowEntrypoint<Env, FeedParams> {
  override async run(event: Readonly<WorkflowEvent<FeedParams>>, step: WorkflowStep) {
    const p = event.payload;
    try {
      const head = await step.do('read header', async () => {
        const object = await this.env.PUBLISHED.head(p.key);
        if (!object) throw new Error(`feed file ${p.key} is missing`);
        if (p.format === 'ndjson') return { offset: 0, row: 1, size: object.size };
        const body = await this.env.PUBLISHED.get(p.key, {
          range: { offset: 0, length: 1_048_576 },
        });
        if (!body) throw new Error(`feed file ${p.key} is missing`);
        // Returning from the loop cancels the rest of the read.
        for await (const r of csvRecords(body.body))
          return { offset: r.end, row: 2, size: object.size, header: csvHeader(r.record) };
        throw new Error('the feed is empty');
      });

      let from: { offset: number; row: number; header?: string[]; size: number } = head;
      for (let chunk = 0; ; chunk++) {
        const out = await step.do(
          `split ${chunk}`,
          { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
          () => splitChunk(this.env, p, chunk, from),
        );
        await step.do(`record ${chunk}`, async () => {
          await feeds(this.env).chunkSplit(p.id, chunk, out);
        });
        if (out.done) break;
        from = { ...from, offset: out.offset, row: out.row };
      }
      await step.do('split done', async () => {
        await feeds(this.env).splitDone(p.id);
      });

      for (let check = 0; ; check++) {
        const status = await step.do(`check ${check}`, async () => {
          const s = await feeds(this.env).get(p.id);
          return { parts: s?.parts ?? 0, partsDone: s?.partsDone ?? 0 };
        });
        if (status.partsDone >= status.parts) break;
        try {
          await step.waitForEvent(`applied ${check}`, { type: 'applied', timeout: '1 minute' });
        } catch {
          // Timed out: look again.
        }
      }
      await step.do('finish', async () => {
        await feeds(this.env).finish(p.id);
      });
    } catch (err) {
      await step.do('fail', async () => {
        await feeds(this.env).fail(p.id, err instanceof Error ? err.message : String(err));
      });
      throw err;
    }
  }
}
