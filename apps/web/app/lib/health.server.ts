import { env, waitUntil } from 'cloudflare:workers';
import {
  HEALTH_CHECK_HEADER,
  HEALTH_WRITE_PATH,
  healthReport,
  remoteChecks,
  runHealthChecks,
  verifyHealthCheck,
} from '@orderloop/core';
import { probeDb } from '@orderloop/db';
import { catalog, db, docs, engine } from './env.server';
import { principalKey } from './principal.server';

const noStore = { 'cache-control': 'no-store' };

/**
 * The deploy smoke test's write check (`POST /health/write`): this Worker's D1 and R2, the
 * engine's D1, R2 and Durable Object storage, and the catalog's objects and bucket each take a
 * write, give it back and lose it again. Every check is named (`engine.objects`, `catalog.shard`),
 * pass or fail only, so CI's log says which store broke and nothing about why; 503 when any did.
 *
 * Only CI can call it: it signs the header (`signHealthCheck`) with a key derived from the
 * principal key, which no person, token or connected app holds, for this path and a minute. The
 * header is passed on to the engine, which checks it again.
 */
export async function writeHealth(request: Request): Promise<Response> {
  const signed = request.headers.get(HEALTH_CHECK_HEADER);
  const keys = [
    principalKey(),
    (env as { PRINCIPAL_KEY_PREVIOUS?: string }).PRINCIPAL_KEY_PREVIOUS,
  ];
  if (!signed || !(await verifyHealthCheck(keys, signed, HEALTH_WRITE_PATH)))
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  const id = `web-${crypto.randomUUID()}`;
  const [own, engineChecks, catalogChecks] = await Promise.all([
    runHealthChecks('orderloop-web', {
      db: () => probeDb(db(), id),
      docs: () => probeBucket(docs(), id, waitUntil),
    }),
    remoteChecks('engine', () => engine().writeHealth(signed)),
    remoteChecks('catalog', () => catalog().writeHealth()),
  ]);
  const report = healthReport('orderloop-web', own.checks, engineChecks, catalogChecks);
  return Response.json(report, { status: report.ok ? 200 : 503, headers: noStore });
}

/** An object under `health/` written, read back and deleted (never under a locked prefix). */
function probeBucket(
  bucket: R2Bucket,
  id: string,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  const key = `health/${id}`;
  const body = crypto.randomUUID();
  const run = (async () => {
    await bucket.put(key, body);
    try {
      const got = await bucket.get(key);
      if ((await got?.text()) !== body) throw new Error('health probe object not read back');
    } finally {
      await bucket.delete(key);
    }
  })();
  // A check that times out answers before its delete: the invocation stays until it has run. One
  // cut off even so is expired by the bucket's `health` lifecycle rule (provision.sh).
  waitUntil(run.catch(() => {}));
  return run;
}
