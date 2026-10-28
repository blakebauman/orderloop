import {
  HEALTH_CHECK_HEADER,
  HEALTH_WRITE_PATH,
  type HealthReport,
  signHealthCheck,
} from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The write check through the web Worker's own `fetch`, with the real setup gate (`awaitingSetup`
// over a `users` count) and the real demo lock: a deployment with no people yet, or a demo, must
// still be write-checked after its deploy.

const KEY = 'test-principal-key-0123456789abcdef';
const env: Record<string, string | undefined> = { PRINCIPAL_KEY: KEY };
vi.mock('cloudflare:workers', () => ({ env, waitUntil: () => {}, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  createRequestHandler: () => async () => new Response('<html>app</html>'),
}));

/** How many people the workspace has: none, so it is waiting for its first admin. */
const people = { n: 0 };
const select = () => {
  const q = { from: () => q, where: () => q, get: async () => people };
  return q;
};
const probeDb = vi.fn(async () => {});
vi.mock('@orderloop/db', async (original) => ({
  ...(await original<typeof import('@orderloop/db')>()),
  probeDb,
}));
const objects = new Map<string, string>();
const bucket = {
  put: async (k: string, v: string) => void objects.set(k, v),
  get: async (k: string) => {
    const v = objects.get(k);
    return v === undefined ? null : { text: async () => v };
  },
  delete: async (k: string) => void objects.delete(k),
};
const ok = (checks: string[]): HealthReport => ({
  ok: true,
  service: 'x',
  checks: Object.fromEntries(checks.map((c) => [c, 'ok' as const])),
});
const engineWrite = vi.fn(async () => ok(['db', 'docs', 'objects']));
vi.mock('~/lib/env.server', () => ({
  db: () => ({ select }),
  docs: () => bucket,
  engine: () => ({ writeHealth: engineWrite }),
  catalog: () => ({ writeHealth: async () => ok(['meta', 'shard', 'published']) }),
  afterResponse: () => {},
}));

const { default: worker } = await import('../workers/app');
const { forgetUserCount } = await import('../app/lib/auth.server');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://acme.orderloop.app${path}`, init) as never, env as never, ctx);
const writeCheck = async () =>
  call(HEALTH_WRITE_PATH, {
    method: 'POST',
    headers: { [HEALTH_CHECK_HEADER]: await signHealthCheck(KEY, HEALTH_WRITE_PATH) },
  });

describe('POST /health/write through the web Worker', () => {
  beforeEach(() => {
    env.DEMO_MODE = undefined;
    people.n = 0;
    forgetUserCount();
    engineWrite.mockClear();
  });

  it('reaches the write check while the workspace is awaiting setup', async () => {
    // The gate is up: anything else is refused until the first admin signs up.
    const refused = await call('/api/v1/orders', { method: 'POST' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'This workspace is not set up yet.' });

    const res = await writeCheck();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'orderloop-web' });
    expect(engineWrite).toHaveBeenCalledOnce();
    // Unsigned, it is refused by the check, not the gate.
    const unsigned = await call(HEALTH_WRITE_PATH, { method: 'POST' });
    expect(unsigned.status).toBe(401);
  });

  it('reaches the write check under the demo lock', async () => {
    env.DEMO_MODE = 'true';
    // The lock is on: credentials and outbound endpoints are refused.
    const locked = await call('/api/v1/integrations');
    expect(locked.status).toBe(403);

    const res = await writeCheck();
    expect(res.status).toBe(200);
    expect((await res.json()) as HealthReport).toMatchObject({
      ok: true,
      checks: { db: 'ok', docs: 'ok', 'engine.objects': 'ok', 'catalog.shard': 'ok' },
    });
  });
});
