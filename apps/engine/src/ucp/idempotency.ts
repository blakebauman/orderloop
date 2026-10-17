/**
 * `Idempotency-Key` for UCP's state-changing operations, per platform. The first request with a
 * key claims it; a repeat with the same body (SHA-256 of the raw bytes, as UCP asks) gets the
 * stored response, one with a different body gets 409, and one that arrives while the first is
 * still running gets 409 too. A request that throws releases its key, so the platform can retry.
 * Keys are kept 24 hours (the retention sweep removes older ones). If the store can't be read or
 * written the request is refused (503), never run without its key.
 */

import { createDb, ucpIdempotency } from '@orderloop/db';
import { and, eq, lt } from 'drizzle-orm';
import type { UcpResult } from './checkout';

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

async function digest(body: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const conflict = (content: string): UcpResult => ({
  status: 409,
  body: { code: 'idempotency_conflict', content },
});

/** Runs `op` at most once for (`ownerId`, `key`, `scope` + `body`). */
export async function once(
  env: Env,
  ownerId: string,
  key: string,
  scope: string,
  body: string,
  op: () => Promise<UcpResult>,
): Promise<UcpResult> {
  const d = createDb(env.DB);
  const hash = await digest(`${scope}\n${body}`);
  const where = and(eq(ucpIdempotency.ownerId, ownerId), eq(ucpIdempotency.key, key));
  let claimed: boolean;
  try {
    // A key older than the TTL is free again.
    await d
      .delete(ucpIdempotency)
      .where(and(where, lt(ucpIdempotency.createdAt, Date.now() - IDEMPOTENCY_TTL_MS)));
    const res = await d
      .insert(ucpIdempotency)
      .values({ ownerId, key, requestHash: hash, createdAt: Date.now() })
      .onConflictDoNothing()
      .returning({ key: ucpIdempotency.key });
    claimed = res.length > 0;
  } catch (err) {
    console.error('ucp idempotency store', err);
    return { status: 503, body: { code: 'unavailable', content: 'Try again shortly.' } };
  }
  if (!claimed) {
    const prior = await d.select().from(ucpIdempotency).where(where).get();
    if (!prior || prior.requestHash !== hash)
      return conflict('This Idempotency-Key was used for a different request.');
    if (prior.status === null)
      return conflict(
        'A request with this Idempotency-Key is still running; get the checkout instead.',
      );
    return { status: prior.status, body: JSON.parse(prior.response ?? 'null') };
  }
  let result: UcpResult;
  try {
    result = await op();
  } catch (err) {
    await d.delete(ucpIdempotency).where(where);
    throw err;
  }
  // A refusal that changed nothing (5xx, a lost race) can be tried again under the same key.
  if (result.status >= 500 || result.status === 409) await d.delete(ucpIdempotency).where(where);
  else
    await d
      .update(ucpIdempotency)
      .set({ status: result.status, response: JSON.stringify(result.body) })
      .where(where);
  return result;
}
