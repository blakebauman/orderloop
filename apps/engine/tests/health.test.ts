import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  HEALTH_WRITE_PATH,
  PRINCIPAL_TTL_MS,
  signHealthCheck,
  signPrincipal,
} from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { healthProbe } from '../src/namespaces';

const key = (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!;
const api = (overrides: Partial<Env> = {}) =>
  new EngineApi(createExecutionContext(), { ...env, ...overrides } as Env);
const fresh = () => signHealthCheck(key, HEALTH_WRITE_PATH);

/**
 * What a write check could have left behind: rows in D1 and in the probe object, objects under
 * health/. Called after a check has run, so the object's table exists.
 */
async function leftovers() {
  const rows = await env.DB.prepare('SELECT count(*) AS n FROM health_probes').first<{
    n: number;
  }>();
  const objects = await env.DOCS.list({ prefix: 'health/' });
  const probes = await runInDurableObject(
    healthProbe(env),
    (_, state) => state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM probes').one().n,
  );
  return { rows: rows?.n, objects: objects.objects.length, probes };
}

describe('EngineApi.health', () => {
  it('reports D1 and R2 as answering', async () => {
    expect(await api().health()).toEqual({
      ok: true,
      service: 'orderloop-engine',
      checks: { db: 'ok', docs: 'ok' },
    });
  });
});

describe('EngineApi.writeHealth', () => {
  it('writes through D1, R2 and its Durable Object, and leaves nothing behind', async () => {
    expect(await api().writeHealth(await fresh())).toEqual({
      ok: true,
      service: 'orderloop-engine',
      checks: { db: 'ok', docs: 'ok', objects: 'ok' },
    });
    expect(await leftovers()).toEqual({ rows: 0, objects: 0, probes: 0 });
    // Again: the second check finds a clean slate, not the first one's ids.
    expect((await api().writeHealth(await fresh())).ok).toBe(true);
  });

  it('writes nothing without a fresh check signed for its path', async () => {
    const refused = { ok: false, service: 'orderloop-engine', checks: { signature: 'fail' } };
    const staff = { kind: 'user' as const, id: 'u', name: 'A', role: 'admin' as const };
    const past = Date.now() - PRINCIPAL_TTL_MS - 1;
    for (const signed of [
      '',
      'not a header',
      await signHealthCheck(key, HEALTH_WRITE_PATH, past),
      await signHealthCheck(key, '/health/deep'),
      await signHealthCheck('another-deployments-principal-key', HEALTH_WRITE_PATH),
      await signPrincipal(key, staff, HEALTH_WRITE_PATH),
    ])
      expect(await api().writeHealth(signed)).toEqual(refused);
    expect(await api({ PRINCIPAL_KEY: '' } as Partial<Env>).writeHealth(await fresh())).toEqual(
      refused,
    );
  });

  it('names the store that refuses a write, and still checks the others', async () => {
    const down = () => {
      throw new Error('store down');
    };
    const brokenDb = { prepare: down, batch: down, exec: down } as unknown as D1Database;
    expect((await api({ DB: brokenDb }).writeHealth(await fresh())).checks).toEqual({
      db: 'fail',
      docs: 'ok',
      objects: 'ok',
    });

    // R2 that takes the write but loses it: the read back fails the check, and it still deletes.
    const deleted: string[] = [];
    const forgetful = {
      put: async () => null,
      get: async () => null,
      delete: async (k: string) => {
        deleted.push(k);
      },
    } as unknown as R2Bucket;
    expect((await api({ DOCS: forgetful }).writeHealth(await fresh())).checks).toEqual({
      db: 'ok',
      docs: 'fail',
      objects: 'ok',
    });
    expect(deleted).toEqual([expect.stringMatching(/^health\/engine-/)]);

    const brokenObjects = {
      getByName: () => ({ probe: async () => down() }),
    } as unknown as Env['HEALTH_PROBE'];
    const report = await api({ HEALTH_PROBE: brokenObjects }).writeHealth(await fresh());
    expect(report).toEqual({
      ok: false,
      service: 'orderloop-engine',
      checks: { db: 'ok', docs: 'ok', objects: 'fail' },
    });
    expect(await leftovers()).toEqual({ rows: 0, objects: 0, probes: 0 });
  });
});
