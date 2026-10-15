import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS,
  AUDIT_MIN_RETENTION_DAYS,
  AUDIT_RETENTION_DAYS,
  auditRetentionDays,
  auditRow,
  type SealedAuditRow,
  sealAuditRow,
  verifyAuditChain,
} from '../src/audit';

async function chainOf(n: number) {
  const rows: SealedAuditRow[] = [];
  for (let i = 0; i < n; i++) {
    const head = rows.at(-1);
    rows.push(
      await sealAuditRow(
        auditRow(`aud_${i}`, 'flow.published', { target: `flow-${i}`, detail: { version: i } }, i),
        head ? { seq: head.seq, hash: head.hash } : null,
      ),
    );
  }
  return rows;
}

describe('the audit hash chain', () => {
  it('numbers events from 1 and links each to the one before', async () => {
    const rows = await chainOf(3);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.prevHash).toBe(AUDIT_GENESIS);
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(await verifyAuditChain(rows, null)).toEqual({
      ok: true,
      checked: 3,
      last: { seq: 3, hash: rows[2]!.hash },
    });
  });

  it('finds an edited, removed or reordered event', async () => {
    const rows = await chainOf(4);
    const edited = rows.map((r, i) => (i === 1 ? { ...r, detail: '{"version":9}' } : r));
    expect(await verifyAuditChain(edited, null)).toMatchObject({ ok: false, brokenAt: 2 });
    expect(await verifyAuditChain([rows[0]!, rows[2]!, rows[3]!], null)).toMatchObject({
      ok: false,
      brokenAt: 3,
    });
    expect(await verifyAuditChain([rows[1]!, rows[0]!], null)).toMatchObject({ ok: false });
  });

  it('checks a pruned chain from its first remaining event, or from a known head', async () => {
    const rows = await chainOf(4);
    expect(await verifyAuditChain(rows.slice(2))).toMatchObject({ ok: true, checked: 2 });
    expect(await verifyAuditChain(rows.slice(2), null)).toMatchObject({ ok: false });
    expect(await verifyAuditChain(rows.slice(2), { seq: 2, hash: rows[1]!.hash })).toMatchObject({
      ok: true,
    });
  });

  it('refuses an event that was never sealed', async () => {
    const legacy = {
      ...auditRow('aud_old', 'auth.sign_in', {}, 0),
      seq: null,
      prevHash: null,
      hash: null,
    };
    expect(await verifyAuditChain([legacy])).toMatchObject({ ok: false, reason: /not sealed/ });
  });
});

describe('audit retention', () => {
  it('defaults to 400 days and never goes under 90', () => {
    expect(auditRetentionDays(undefined)).toBe(AUDIT_RETENTION_DAYS);
    expect(auditRetentionDays('abc')).toBe(AUDIT_RETENTION_DAYS);
    expect(auditRetentionDays('2555')).toBe(2555);
    expect(auditRetentionDays('7')).toBe(AUDIT_MIN_RETENTION_DAYS);
  });
});
