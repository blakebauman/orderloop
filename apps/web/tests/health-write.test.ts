import {
  HEALTH_CHECK_HEADER,
  HEALTH_WRITE_PATH,
  type HealthReport,
  PRINCIPAL_TTL_MS,
  signHealthCheck,
  signPrincipal,
} from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'test-principal-key-0123456789abcdef';
const workerEnv: Record<string, string | undefined> = { PRINCIPAL_KEY: KEY };
vi.mock('cloudflare:workers', () => ({ env: workerEnv }));

const probeDb = vi.fn(async () => {});
vi.mock('@orderloop/db', () => ({ probeDb }));

/** An R2 bucket in memory, or one whose every call throws. */
let objects = new Map<string, string>();
let bucketDown = false;
const bucket = {
  put: vi.fn(async (k: string, v: string) => {
    if (bucketDown) throw new Error('R2 down');
    objects.set(k, v);
  }),
  get: vi.fn(async (k: string) => {
    if (bucketDown) throw new Error('R2 down');
    const v = objects.get(k);
    return v === undefined ? null : { text: async () => v };
  }),
  delete: vi.fn(async (k: string) => {
    if (bucketDown) throw new Error('R2 down');
    objects.delete(k);
  }),
};

const ok = (service: string, checks: string[]): HealthReport => ({
  ok: true,
  service,
  checks: Object.fromEntries(checks.map((c) => [c, 'ok' as const])),
});
const writeHealthEngine = vi.fn(async (_signed: string) =>
  ok('orderloop-engine', ['db', 'docs', 'objects']),
);
const writeHealthCatalog = vi.fn(async () =>
  ok('orderloop-catalog', ['meta', 'shard', 'published']),
);
vi.mock('~/lib/env.server', () => ({
  db: () => 'db',
  docs: () => bucket,
  engine: () => ({ writeHealth: writeHealthEngine }),
  catalog: () => ({ writeHealth: writeHealthCatalog }),
}));

const { writeHealth } = await import('~/lib/health.server');

const call = (header?: string) =>
  writeHealth(
    new Request(`https://acme.orderloop.app${HEALTH_WRITE_PATH}`, {
      method: 'POST',
      headers: header === undefined ? {} : { [HEALTH_CHECK_HEADER]: header },
    }),
  );

const ALL_OK = {
  db: 'ok',
  docs: 'ok',
  'engine.db': 'ok',
  'engine.docs': 'ok',
  'engine.objects': 'ok',
  'catalog.meta': 'ok',
  'catalog.shard': 'ok',
  'catalog.published': 'ok',
};

describe('POST /health/write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    objects = new Map();
    bucketDown = false;
    workerEnv.PRINCIPAL_KEY = KEY;
    workerEnv.PRINCIPAL_KEY_PREVIOUS = undefined;
  });

  it('writes through every store with a fresh signed check, and leaves no object behind', async () => {
    const signed = await signHealthCheck(KEY, HEALTH_WRITE_PATH);
    const res = await call(signed);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, service: 'orderloop-web', checks: ALL_OK });
    expect(probeDb).toHaveBeenCalledWith('db', expect.stringMatching(/^web-/));
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^health\/web-/),
      expect.any(String),
    );
    expect(objects.size).toBe(0);
    // The engine checks the same header again for itself.
    expect(writeHealthEngine).toHaveBeenCalledWith(signed);
  });

  it('accepts a check signed with the previous key during a rotation', async () => {
    workerEnv.PRINCIPAL_KEY = 'the-new-principal-key-0123456789abcdef';
    workerEnv.PRINCIPAL_KEY_PREVIOUS = KEY;
    expect((await call(await signHealthCheck(KEY, HEALTH_WRITE_PATH))).status).toBe(200);
  });

  it('refuses anything but a fresh check for this path, before writing anything', async () => {
    const staff = { kind: 'user' as const, id: 'u', name: 'A', role: 'admin' as const };
    for (const header of [
      undefined,
      '',
      'not a header',
      await signHealthCheck(KEY, HEALTH_WRITE_PATH, Date.now() - PRINCIPAL_TTL_MS - 1),
      await signHealthCheck(KEY, '/health/deep'),
      await signHealthCheck('another-deployments-key-0123456789', HEALTH_WRITE_PATH),
      // A principal header for this path, as the web app signs one for the engine.
      await signPrincipal(KEY, staff, HEALTH_WRITE_PATH),
    ]) {
      const res = await call(header);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(probeDb).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(writeHealthEngine).not.toHaveBeenCalled();
    expect(writeHealthCatalog).not.toHaveBeenCalled();
  });

  it('names each store that fails, with a 503, and still checks the rest', async () => {
    const signed = await signHealthCheck(KEY, HEALTH_WRITE_PATH);
    const failing = async () => {
      const res = await call(signed);
      expect(res.status).toBe(503);
      const body = (await res.json()) as HealthReport;
      expect(body.ok).toBe(false);
      return Object.entries(body.checks)
        .filter(([, s]) => s !== 'ok')
        .map(([k]) => k);
    };

    probeDb.mockRejectedValueOnce(new Error('D1_ERROR: no such table: health_probes'));
    expect(await failing()).toEqual(['db']);

    bucketDown = true;
    expect(await failing()).toEqual(['docs']);
    bucketDown = false;

    // The engine's own store, by name; and an engine that doesn't answer at all.
    writeHealthEngine.mockResolvedValueOnce({
      ok: false,
      service: 'orderloop-engine',
      checks: { db: 'ok', docs: 'ok', objects: 'fail' },
    });
    expect(await failing()).toEqual(['engine.objects']);
    writeHealthEngine.mockRejectedValueOnce(new Error('engine binding down'));
    expect(await failing()).toEqual(['engine']);
    // An engine on another key than the web app's refuses the check.
    writeHealthEngine.mockResolvedValueOnce({
      ok: false,
      service: 'orderloop-engine',
      checks: { signature: 'fail' },
    });
    expect(await failing()).toEqual(['engine.signature']);

    writeHealthCatalog.mockResolvedValueOnce({
      ok: false,
      service: 'orderloop-catalog',
      checks: { meta: 'ok', shard: 'fail', published: 'ok' },
    });
    expect(await failing()).toEqual(['catalog.shard']);
    writeHealthCatalog.mockRejectedValueOnce(new Error('catalog binding down'));
    expect(await failing()).toEqual(['catalog']);
  });

  it('says nothing about why a store failed', async () => {
    probeDb.mockRejectedValueOnce(new Error('D1_ERROR: secret detail'));
    const res = await call(await signHealthCheck(KEY, HEALTH_WRITE_PATH));
    expect(await res.text()).not.toContain('secret');
  });
});
