import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DOC_FORMAT, paths } from '@orderloop/core/product';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifestKey, OBJECTS } from '../src/backup';
import { PITR_DAYS, parseRestore, rewindObject } from '../src/restore';
import { api, by, doc, finish, product, settle, setup } from './helpers';

// Its own file: storage is per test file, and a second backup on the same day copies nothing.
beforeAll(setup);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('restoring a backup', () => {
  it('restores a backup over later changes and republishes what it restored', async () => {
    const [a, b, c] = [product(), product(), product()];
    await api.putProducts([a, b, c], { by });
    const descFr = { field: 'description', locale: 'fr' } as const;
    expect(
      await api.stageEdits([{ key: a.key, ref: descFr, op: 'set', value: 'Un t-shirt.' }], by),
    ).toMatchObject([{ ok: true }]);
    await settle();
    const original = await api.getProduct(b.key);

    const { date } = await finish<{ date: string }>(env.CATALOG_BACKUP);
    expect(await env.PUBLISHED.head(manifestKey(date))).not.toBeNull();

    // After the backup: b changes, c goes, a new type and channel come with a product in it.
    await api.putProducts([{ ...b, title: { en: 'Renamed' } }], { by });
    await api.deleteProducts([c.key], { by });
    await api.discardStaged([{ key: a.key }], by);
    expect(
      (await api.putType({ code: 'gadget', version: 1, attributes: [], variantAxes: [] }, by)).ok,
    ).toBe(true);
    const outlet = {
      code: 'outlet',
      name: 'Outlet',
      currency: 'USD',
      locales: ['en'],
      defaultLocale: 'en',
    };
    expect((await api.putChannel(outlet, by)).ok).toBe(true);
    const d = product({
      channels: {
        web: { visible: true, price: { amount: 999, currency: 'USD' } },
        outlet: { visible: true, price: { amount: 499, currency: 'USD' } },
      },
    });
    await api.putProducts([d], { by });
    await settle();
    expect(await doc(c.key)).toBeNull();
    expect(await env.PUBLISHED.head(paths.doc(DOC_FORMAT, 'outlet', 'en', d.key))).not.toBeNull();
    expect((await doc(b.key))?.version).toBe(2);

    const out = await finish<{
      mode: string;
      undo: Record<string, string | null>;
      republished: number;
      channelsRemoved: string[];
    }>(env.CATALOG_RESTORE, { backup: date });
    expect(out).toMatchObject({ mode: 'backup', channelsRemoved: ['outlet'] });
    expect(Object.keys(out.undo).sort()).toEqual([...OBJECTS].sort());
    await settle();

    // The products, types, channels and editor state are the backup's.
    expect(await api.getProduct(b.key)).toEqual(original);
    expect((await api.getProduct(c.key))?.key).toBe(c.key);
    expect(await api.getProduct(d.key)).toBeNull();
    expect((await api.listTypes()).map((t) => t.code)).toEqual(['apparel']);
    expect((await api.listChannels()).map((ch) => ch.code)).toEqual(['web']);
    expect((await api.getProductSheet(a.key))?.staged).toMatchObject([
      { ref: descFr, op: 'set', value: 'Un t-shirt.' },
    ]);
    // And republished: b's document is its version again, c's is back, d's and the outlet's gone.
    expect((await doc(b.key))?.version).toBe(1);
    expect(await doc(c.key)).not.toBeNull();
    expect(await doc(d.key)).toBeNull();
    expect(await env.PUBLISHED.head(paths.doc(DOC_FORMAT, 'outlet', 'en', d.key))).toBeNull();
    expect(await env.PUBLISHED.head(paths.categories(DOC_FORMAT, 'outlet', 'en'))).toBeNull();
    // A new product after the restore still gets a uid of its own.
    const e = product();
    expect((await api.putProducts([e], { by }))[0]?.status).toBe('created');
  });

  it('refuses a backup that does not exist without touching the catalog', async () => {
    introspector = await introspectWorkflow(env.CATALOG_RESTORE);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
    });
    const p = product();
    await api.putProducts([p], { by });
    // Refused as the manifest is read (`no backup for 2001-01-01`), with no retries.
    await expect(finish(env.CATALOG_RESTORE, { backup: '2001-01-01' })).rejects.toThrow(
      'NonRetryableError',
    );
    expect((await api.getProduct(p.key))?.key).toBe(p.key);
  });
});

describe('point-in-time restore', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');

  it('takes exactly one of a time, bookmarks or a backup', () => {
    expect(parseRestore({ at: now - 60_000 }, now)).toEqual({
      mode: 'at',
      at: now - 60_000,
      merge: [],
    });
    expect(parseRestore({ at: '2026-10-27T11:00:00Z', merge: ['abc-1'] }, now)).toEqual({
      mode: 'at',
      at: now - 3_600_000,
      merge: ['abc-1'],
    });
    expect(parseRestore({ backup: '2026-10-20' }, now)).toEqual({
      mode: 'backup',
      date: '2026-10-20',
    });
    expect(parseRestore({ bookmarks: { meta: 'bm-1', 'shard-63': 'bm-2' } }, now)).toEqual({
      mode: 'bookmarks',
      bookmarks: { meta: 'bm-1', 'shard-63': 'bm-2' },
      merge: [],
    });
    for (const [params, message] of [
      [{}, 'exactly one'],
      [{ at: now - 1000, backup: '2026-10-20' }, 'exactly one'],
      [{ at: now + 1000 }, 'in the past'],
      [{ at: now - (PITR_DAYS + 1) * 86_400_000 }, `more than ${PITR_DAYS} days`],
      [{ at: 'yesterday' }, 'a time'],
      [{ backup: '20/10/2026' }, 'yyyy-mm-dd'],
      [{ backup: '2026-10-20', merge: ['x'] }, '"merge" goes with'],
      [{ bookmarks: { 'shard-64': 'bm' } }, 'no catalog object shard-64'],
      [{ bookmarks: {} }, 'maps objects'],
      [{ at: now - 1000, merge: ['../docs'] }, 'restore instance ids'],
    ] as const)
      expect(() => parseRestore(params, now)).toThrow(message);
  });

  it('rewinds an object, then resets it, whose call fails as it ends the session', async () => {
    const calls: string[] = [];
    const stub = {
      rewind: async (bookmark: string) => {
        calls.push(`rewind ${bookmark}`);
        return 'undo-1';
      },
      reset: async () => {
        calls.push('reset');
        throw new Error('Durable Object reset: restoring a bookmark');
      },
    };
    expect(await rewindObject(stub, 'bm-1')).toBe('undo-1');
    expect(calls).toEqual(['rewind bm-1', 'reset']);

    // A bookmark refused: no reset, so the object goes on as it was.
    calls.length = 0;
    stub.rewind = async (bookmark) => {
      calls.push(`rewind ${bookmark}`);
      throw new Error('bad bookmark');
    };
    await expect(rewindObject(stub, 'bm-2')).rejects.toThrow('bad bookmark');
    expect(calls).toEqual(['rewind bm-2']);
  });

  // workerd's storage has no point-in-time recovery, so a rewind can't be shown working here: the
  // test shows the Workflow asks every object for its bookmark first, and that the failure stops
  // it before any object is captured or moved.
  it('fails before moving anything where storage has no point-in-time recovery', async () => {
    introspector = await introspectWorkflow(env.CATALOG_RESTORE);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
    });
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    await expect(finish(env.CATALOG_RESTORE, { at: Date.now() - 60_000 })).rejects.toThrow(
      'point-in-time recovery',
    );
    expect((await env.PUBLISHED.list({ prefix: 'restores/' })).objects).toEqual([]);
    expect((await api.getProduct(p.key))?.key).toBe(p.key);
    expect(await doc(p.key)).not.toBeNull();
  });
});
