/**
 * CatalogPublisher: does a shard's storage writes, so a shard isn't limited to the handful of
 * writes one invocation can have in flight. A Workers invocation (a shard's alarm included) can
 * only have six storage calls waiting for a response at once, and an R2 or KV write waits until it
 * is stored, so a shard writing ~700 objects a pass alone would publish a few products a second.
 * Each shard hands its writes to PUBLISH_FANOUT publishers instead, each its own invocation.
 *
 * A product's writes always go to the same publisher (by its key's hash), and the shard waits for
 * every publisher before its next pass, so one product's writes are never reordered.
 */
import { DurableObject } from 'cloudflare:workers';
import { fnv1a64Parts } from '@orderloop/core/product';

/** One storage write, as plain data so it crosses RPC. */
export type WriteOp =
  | { put: 'r2'; key: string; body: string; contentType?: string; version?: string }
  | { put: 'kv'; key: string; value: string }
  | { delete: 'r2'; keys: string[] }
  | { delete: 'kv'; key: string };

/** Which of a shard's `fanout` publishers handles `key`. */
export function publisherOf(key: string, fanout: number): number {
  const [, lo] = fnv1a64Parts(`w:${key}`);
  return lo % fanout;
}

export async function runOps(env: Env, ops: WriteOp[]): Promise<void> {
  const run = (op: WriteOp): Promise<unknown> => {
    if ('put' in op)
      return op.put === 'r2'
        ? env.PUBLISHED.put(op.key, op.body, {
            httpMetadata: op.contentType ? { contentType: op.contentType } : undefined,
            customMetadata: op.version ? { version: op.version } : undefined,
          })
        : env.CARDS.put(op.key, op.value);
    return op.delete === 'r2' ? env.PUBLISHED.delete(op.keys) : env.CARDS.delete(op.key);
  };
  // All at once: the runtime queues those past six and starts each as a slot frees, so no write
  // waits for a slower one in its group (a call carries one pass's share, a few dozen writes).
  await Promise.all(ops.map(run));
}

export class CatalogPublisher extends DurableObject<Env> {
  async write(ops: WriteOp[]): Promise<number> {
    await runOps(this.env, ops);
    return ops.length;
  }
}
