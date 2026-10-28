import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CatalogApi } from '../src/api';
import { meta, shard } from '../src/config';
import { api } from './helpers';

const withEnv = (overrides: Partial<Env>) =>
  new CatalogApi(createExecutionContext(), { ...env, ...overrides } as Env);

/** Rows left in an object's probe table (after a check, so the table exists). */
const rowsIn = (stub: DurableObjectStub) =>
  runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM health_probes').one().n,
  );

describe('CatalogApi.writeHealth', () => {
  it('writes through CatalogMeta, a shard and the published bucket, and leaves nothing behind', async () => {
    const before = await env.PUBLISHED.list();
    expect(await api.writeHealth()).toEqual({
      ok: true,
      service: 'orderloop-catalog',
      checks: { meta: 'ok', shard: 'ok', published: 'ok' },
    });
    expect(await rowsIn(meta(env) as unknown as DurableObjectStub)).toBe(0);
    expect(await rowsIn(shard(env, 0) as unknown as DurableObjectStub)).toBe(0);
    // Nothing published, and no product or outbox row touched.
    expect((await env.PUBLISHED.list()).objects).toEqual(before.objects);
    await runInDurableObject(shard(env, 0) as unknown as DurableObjectStub, (_, state) => {
      const sql = state.storage.sql;
      expect(sql.exec('SELECT count(*) AS n FROM outbox').one().n).toBe(0);
      expect(sql.exec('SELECT count(*) AS n FROM products').one().n).toBe(0);
    });
  });

  it('names the store that refuses a write, and still checks the others', async () => {
    const down = async () => {
      throw new Error('bucket down');
    };
    const broken = { put: down, get: down, delete: down } as unknown as R2Bucket;
    expect(await withEnv({ PUBLISHED: broken }).writeHealth()).toEqual({
      ok: false,
      service: 'orderloop-catalog',
      checks: { meta: 'ok', shard: 'ok', published: 'fail' },
    });
    const objects = {
      getByName: () => ({ probe: down }),
    } as unknown as Env['SHARD'];
    expect((await withEnv({ SHARD: objects }).writeHealth()).checks).toEqual({
      meta: 'ok',
      shard: 'fail',
      published: 'ok',
    });
    expect((await withEnv({ META: objects as never }).writeHealth()).checks).toEqual({
      meta: 'fail',
      shard: 'ok',
      published: 'ok',
    });
  });
});
