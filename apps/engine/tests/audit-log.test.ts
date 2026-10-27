import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { auditRow, sealAuditRow, verifyAuditChain } from '@orderloop/core';
import { appendAudit, auditEvents, createDb } from '@orderloop/db';
import { asc } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { archiveAudit, auditArchiveKey } from '../src/retention';

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[]; AUDIT_DB: D1Database };
const auditEnv = { ...testEnv, DB: testEnv.AUDIT_DB, AUDIT_RETENTION_DAYS: '400' } as Env;
const db = () => createDb(testEnv.AUDIT_DB);
const DAY = 86_400_000;
const now = Date.now();

const append = (id: string, at: number) =>
  appendAudit(db(), (head) => sealAuditRow(auditRow(id, 'auth.sign_in', { target: id }, at), head));

/** The error a statement fails with, or null. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => `${e.message} ${e.cause ?? ''}`,
  );

const chain = () => db().select().from(auditEvents).orderBy(asc(auditEvents.seq));

beforeAll(async () => {
  await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_MIGRATIONS);
});

describe('the audit log', () => {
  it('seals events into one chain, even when writers race', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => append(`aud_race_${i}`, now - 500 * DAY + i)),
    );
    const rows = await chain();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await verifyAuditChain(rows, null)).toMatchObject({ ok: true, checked: 8 });
  });

  it('refuses to change an event, or delete one younger than 90 days', async () => {
    await append('aud_recent', now);
    expect(
      await refusal(testEnv.AUDIT_DB.prepare(`UPDATE audit_events SET actor = 'x'`).run()),
    ).toMatch(/cannot be changed/);
    expect(
      await refusal(
        testEnv.AUDIT_DB.prepare(`DELETE FROM audit_events WHERE id = 'aud_recent'`).run(),
      ),
    ).toMatch(/at least 90 days/);
  });

  it('archives events past the retention to R2, then deletes them, leaving an unbroken chain', async () => {
    // Before the chain: no seq.
    await testEnv.AUDIT_DB.prepare(
      `INSERT INTO audit_events (id, at, action) VALUES ('aud_legacy', ?, 'auth.sign_in')`,
    )
      .bind(now - 600 * DAY)
      .run();
    // Older than the retention, but after a newer event in the chain: it stays, so the chain does.
    await append('aud_late_old', now - 450 * DAY);

    expect(await archiveAudit(auditEnv, now)).toBe(9);

    const left = await chain();
    expect(left.map((r) => r.id)).toEqual(['aud_recent', 'aud_late_old']);
    expect(await verifyAuditChain(left)).toMatchObject({ ok: true, checked: 2 });

    const listed = await testEnv.DOCS.list({ prefix: 'audit/' });
    const archived = (
      await Promise.all(listed.objects.map(async (o) => (await testEnv.DOCS.get(o.key))!.text()))
    )
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as typeof auditEvents.$inferSelect);
    expect(archived.map((r) => r.id).sort()).toEqual(
      ['aud_legacy', ...Array.from({ length: 8 }, (_, i) => `aud_race_${i}`)].sort(),
    );
    // Archive and database together still verify from the first event.
    const sealed = archived.filter((r) => r.seq !== null).sort((a, b) => a.seq! - b.seq!);
    expect(await verifyAuditChain([...sealed, ...left], null)).toMatchObject({
      ok: true,
      checked: 10,
    });

    expect(await archiveAudit(auditEnv, now)).toBe(0);
  });

  it('deletes a batch already archived without writing its object again, which the lock refuses', async () => {
    const at = now - 700 * DAY;
    for (const id of ['aud_retry_a', 'aud_retry_b'])
      await testEnv.AUDIT_DB.prepare(
        `INSERT INTO audit_events (id, at, action) VALUES (?, ?, 'auth.sign_in')`,
      )
        .bind(id, at)
        .run();
    // A sweep wrote this batch's object, then stopped before deleting its events.
    const key = auditArchiveKey({ at, id: 'aud_retry_a' }, 2);
    await testEnv.DOCS.put(key, 'written before\n');
    // As the bucket lock does: an object under audit/ can't be overwritten.
    const docs = testEnv.DOCS;
    const locked = Object.assign(Object.create(docs), {
      head: docs.head.bind(docs),
      put: async (k: string, ...rest: unknown[]) => {
        if (await docs.head(k)) throw new Error('The object is locked by the bucket policy.');
        return (docs.put as (...a: unknown[]) => unknown)(k, ...rest);
      },
    }) as R2Bucket;

    expect(await archiveAudit({ ...auditEnv, DOCS: locked } as Env, now)).toBe(2);
    expect((await chain()).map((r) => r.id)).toEqual(['aud_recent', 'aud_late_old']);
    expect(await (await docs.get(key))!.text()).toBe('written before\n');
  });
});
