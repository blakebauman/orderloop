import { introspectWorkflow, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DOC_FORMAT, paths, productShard } from '@orderloop/core/product';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chunkKey,
  type Manifest,
  manifestKey,
  OBJECTS,
  readManifest,
  rewindInPlace,
  undoKey,
} from '../src/backup';
import { keepBefore, mergeCaptured, PITR_DAYS, parseRestore, rewindObject } from '../src/restore';
import { alias, api, by, doc, finish, product, settle, setup } from './helpers';

// Its own file: storage is per test file, and a second backup on the same day copies nothing.
beforeAll(setup);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

/** Retries without their waits, for a restore expected to fail. */
async function failFast() {
  introspector = await introspectWorkflow(env.CATALOG_RESTORE);
  await introspector.modifyAll(async (m) => {
    await m.disableRetryDelays();
  });
}

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
    // As an earlier attempt that loaded meta and then failed would leave it: the outlet already
    // gone from the config. It must still be taken down, found from what was published.
    await runInDurableObject(env.META.getByName('meta'), (_i, state) => {
      state.storage.sql.exec(`DELETE FROM channels WHERE code = 'outlet'`);
    });

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

  it('checks the whole backup first: a missing chunk changes nothing and says how to undo', async () => {
    await failFast();
    const { date } = await finish<{ date: string }>(env.CATALOG_BACKUP);
    const manifest = (await readManifest(env.PUBLISHED, date)) as Manifest;
    const object = OBJECTS.find((o) => (manifest.objects[o]?.tables.products?.chunks ?? 0) > 0);
    const key = chunkKey(`backups/${date}/${object}/`, 'products', 0);
    await env.PUBLISHED.delete(key);
    const extra = product();
    await api.putProducts([extra], { by });
    expect(
      (await api.putType({ code: 'later', version: 1, attributes: [], variantAxes: [] }, by)).ok,
    ).toBe(true);

    const failed = finish(env.CATALOG_RESTORE, { backup: date });
    await expect(failed).rejects.toThrow(`${key} is missing`);
    await expect(failed).rejects.toThrow(/restores\/[^/]+\/before\.json/);
    // Neither meta nor any shard was touched.
    expect((await api.listTypes()).map((t) => t.code)).toContain('later');
    expect((await api.getProduct(extra.key))?.key).toBe(extra.key);
  });

  it('refuses a backup that does not exist without touching the catalog', async () => {
    await failFast();
    const p = product();
    await api.putProducts([p], { by });
    await expect(finish(env.CATALOG_RESTORE, { backup: '2001-01-01' })).rejects.toThrow(
      'no backup for 2001-01-01',
    );
    expect((await api.getProduct(p.key))?.key).toBe(p.key);
  });

  it('keeps the earliest catalog of the attempts it merges as its undo', async () => {
    const first = await keepBefore(env.PUBLISHED, 'first-try', [], {
      rev: 7,
      channels: ['web', 'outlet'],
      undo: { meta: 'A', 'shard-0': null },
    });
    expect(first.undo.meta).toBe('A');
    // The second run sees the half-restored catalog: the first run's bookmarks win.
    const found = { rev: 3, channels: ['web'], undo: { meta: 'B', 'shard-0': 'C' } };
    expect(await keepBefore(env.PUBLISHED, 'second-try', ['first-try'], found)).toEqual({
      rev: 7,
      channels: ['web', 'outlet'],
      undo: { meta: 'A', 'shard-0': 'C' },
    });
    // Kept once: a retried step reads it back, whatever it found the second time.
    expect(
      (await keepBefore(env.PUBLISHED, 'second-try', [], { rev: 9, channels: [], undo: {} })).rev,
    ).toBe(7);
    await expect(keepBefore(env.PUBLISHED, 'third-try', ['no-such-run'], found)).rejects.toThrow(
      'no restore no-such-run to merge',
    );
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
    expect(parseRestore({ backup: '2026-10-20', merge: ['abc-1'] }, now)).toEqual({
      mode: 'backup',
      date: '2026-10-20',
      merge: ['abc-1'],
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
      [{ bookmarks: { 'shard-64': 'bm' } }, 'no catalog object shard-64'],
      [{ bookmarks: {} }, 'maps objects'],
      [{ at: now - 1000, merge: ['../docs'] }, 'restore instance ids'],
    ] as const)
      expect(() => parseRestore(params, now)).toThrow(message);
  });

  it('counts a rewind only once the object has restarted with its undo kept', async () => {
    const prefix = 'restores/rewind-test/meta/';
    let session = 's1';
    const calls: string[] = [];
    // As the object does: keep the undo bookmark (the first one only), then abort.
    const aborting = {
      session: async () => session,
      rewindTo: async (bookmark: string) => {
        calls.push(`rewindTo ${bookmark}`);
        if (!(await env.PUBLISHED.head(undoKey(prefix))))
          await env.PUBLISHED.put(undoKey(prefix), '{}', {
            customMetadata: { undo: `undo-of-${session}` },
          });
        session = `${session}+`;
        throw new Error('Durable Object reset because its code was aborted');
      },
    };
    expect(await rewindObject(() => aborting, env.PUBLISHED, 'bm-1', prefix)).toBe('undo-of-s1');
    // A retry after it took: rewound again to the same point, the first undo still the one kept.
    expect(await rewindObject(() => aborting, env.PUBLISHED, 'bm-1', prefix)).toBe('undo-of-s1');
    expect(calls).toEqual(['rewindTo bm-1', 'rewindTo bm-1']);

    // A call that never reached the object: nothing set, its own error.
    const unreached = {
      session: async () => 's2',
      rewindTo: async () => {
        throw new Error('network connection lost');
      },
    };
    await expect(
      rewindObject(() => unreached, env.PUBLISHED, 'bm-1', 'restores/rewind-test/shard-1/'),
    ).rejects.toThrow('network connection lost');
    // The rewind set (its undo kept) but the object still on its old session: retry, not done.
    await env.PUBLISHED.put(undoKey('restores/rewind-test/shard-2/'), '{}', {
      customMetadata: { undo: 'u' },
    });
    await expect(
      rewindObject(() => unreached, env.PUBLISHED, 'bm-1', 'restores/rewind-test/shard-2/'),
    ).rejects.toThrow("hasn't restarted");
  });

  // workerd has no point-in-time recovery: the bookmark calls are stood in for, on a real shard.
  it('copies published before setting the rewind, and the copy takes down what the rewind forgets', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    expect(await doc(p.key)).not.toBeNull();
    expect(await alias(`slug:en:${p.slug?.en}`)).toEqual({ key: p.key });
    const n = productShard(p.key);
    const stub = env.SHARD.getByName(`shard-${n}`);
    const prefix = `restores/capture-test/shard-${n}/`;
    const order: string[] = [];
    await runInDurableObject(stub, async (_i, state) => {
      await rewindInPlace(
        {
          sql: state.storage.sql,
          storage: {
            onNextSessionRestoreBookmark: async (bookmark: string) => {
              const copied = (await env.PUBLISHED.list({ prefix })).objects.map((o) =>
                o.key.slice(prefix.length),
              );
              order.push(`set ${bookmark} with ${copied.join(',')} copied`);
              return 'undo-1';
            },
          },
          abort: () => order.push('abort'),
          bucket: env.PUBLISHED,
        },
        'bm-1',
        prefix,
        true,
      );
    });
    expect(order).toEqual(['set bm-1 with published-0.ndjson copied', 'abort']);
    expect((await env.PUBLISHED.head(undoKey(prefix)))?.customMetadata?.undo).toBe('undo-1');

    // As the rewind leaves the shard: from before the product, so no row for it anywhere.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec('DELETE FROM products WHERE key = ?', p.key);
      state.storage.sql.exec('DELETE FROM published WHERE key = ?', p.key);
    });
    expect(await mergeCaptured(env, ['capture-test'], n)).toBeGreaterThan(0);
    await stub.afterRestore(n);
    await settle();
    expect(await doc(p.key)).toBeNull();
    expect(await alias(`slug:en:${p.slug?.en}`)).toBeNull();
  });

  it('fails before moving anything where storage has no point-in-time recovery', async () => {
    await failFast();
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    await expect(finish(env.CATALOG_RESTORE, { at: Date.now() - 60_000 })).rejects.toThrow(
      'point-in-time recovery',
    );
    // Only what the catalog was before is kept; no shard copied or moved anything.
    const kept = (await env.PUBLISHED.list({ prefix: 'restores/' })).objects.map((o) => o.key);
    expect(kept.filter((k) => !k.endsWith('/before.json') && !k.includes('-test/'))).toEqual([]);
    expect(kept.some((k) => k.endsWith('/before.json'))).toBe(true);
    expect((await api.getProduct(p.key))?.key).toBe(p.key);
    expect(await doc(p.key)).not.toBeNull();
  });
});
