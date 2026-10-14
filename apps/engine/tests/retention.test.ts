import { env } from 'cloudflare:workers';
import {
  createDb,
  inboundEmails,
  nodeRuns,
  sessions,
  users,
  webhookDeliveries,
  webhookReceipts,
} from '@orderloop/db';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RETENTION, sweep } from '../src/retention';

const db = () => createDb(env.DB);
const DAY = 86_400_000;

describe('retention sweep', () => {
  it('deletes what is past its retention and keeps the rest', async () => {
    const now = Date.now();
    await db()
      .insert(users)
      .values({
        id: 'usr_ret',
        email: 'ret@example.com',
        name: 'ret',
        role: 'viewer',
        createdAt: 0,
      })
      .onConflictDoNothing();
    await db()
      .insert(sessions)
      .values([
        { tokenHash: 'ret-expired', userId: 'usr_ret', createdAt: 0, expiresAt: now - 1 },
        { tokenHash: 'ret-live', userId: 'usr_ret', createdAt: 0, expiresAt: now + DAY },
      ]);
    const delivery = (id: string, createdAt: number, status: string) => ({
      id,
      subscriptionId: 'sub_ret',
      orderId: 'ord_ret',
      event: 'order.completed',
      payload: '{}',
      status,
      createdAt,
    });
    const old = now - RETENTION.webhookDeliveriesMs - DAY;
    await db()
      .insert(webhookDeliveries)
      .values([
        delivery('whd_ret_old', old, 'delivered'),
        delivery('whd_ret_pending', old, 'pending'),
        delivery('whd_ret_new', now, 'delivered'),
      ]);
    const run = (nodeId: string, endedAt: number) => ({
      orderId: 'ord_ret',
      generation: 1,
      nodeId,
      run: 1,
      nodeType: 'commerce.validate',
      model: 'b2b',
      status: 'succeeded',
      startedAt: endedAt,
      endedAt,
      durationMs: 1,
    });
    await db()
      .insert(nodeRuns)
      .values([run('old', now - RETENTION.nodeRunsMs - DAY), run('new', now)]);
    const email = (id: string, receivedAt: number) => ({
      id,
      messageId: `<${id}>`,
      mailbox: 'orders@example.com',
      sender: 'a@example.com',
      status: 'rejected',
      receivedAt,
    });
    await db()
      .insert(inboundEmails)
      .values([
        email('eml_ret_old', now - RETENTION.inboundEmailsMs - DAY),
        email('eml_ret_new', now),
      ]);
    await db()
      .insert(webhookReceipts)
      .values([
        { id: 'event:ret-old', receivedAt: now - RETENTION.webhookReceiptsMs - 1 },
        { id: 'event:ret-new', receivedAt: now },
      ]);

    const swept = await sweep(env, now);
    expect(swept).toMatchObject({
      sessions: expect.any(Number),
      webhookDeliveries: 1,
      nodeRuns: 1,
      inboundEmails: 1,
      webhookReceipts: 1,
    });

    const left = async <T extends { id: string }>(rows: Promise<T[]>) =>
      (await rows).map((r) => r.id).sort();
    expect(
      (
        await db()
          .select()
          .from(sessions)
          .where(inArray(sessions.tokenHash, ['ret-expired', 'ret-live']))
      ).map((s) => s.tokenHash),
    ).toEqual(['ret-live']);
    expect(
      await left(
        db()
          .select()
          .from(webhookDeliveries)
          .where(inArray(webhookDeliveries.id, ['whd_ret_old', 'whd_ret_pending', 'whd_ret_new'])),
      ),
    ).toEqual(['whd_ret_new', 'whd_ret_pending']);
    expect(
      (
        await db()
          .select()
          .from(nodeRuns)
          .where(inArray(nodeRuns.nodeId, ['old', 'new']))
      ).map((r) => r.nodeId),
    ).toEqual(['new']);
    expect(
      await left(
        db()
          .select()
          .from(inboundEmails)
          .where(inArray(inboundEmails.id, ['eml_ret_old', 'eml_ret_new'])),
      ),
    ).toEqual(['eml_ret_new']);
  });
});
