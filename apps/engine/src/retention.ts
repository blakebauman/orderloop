/**
 * Retention: a daily sweep (the Worker's cron trigger) that deletes rows nothing reads once they
 * are old. Orders and everything that is part of an order's record (payments, shipments, the stock
 * and balance ledgers, flow versions) are kept; the audit log prunes itself on write (180 days).
 */

import {
  createDb,
  inboundEmails,
  nodeRuns,
  sessions,
  webhookDeliveries,
  webhookReceipts,
} from '@orderloop/db';
import { and, lt, ne } from 'drizzle-orm';

const DAY = 86_400_000;

/** How long each kind of row is kept. */
export const RETENTION = {
  /** Delivered or abandoned outbound webhooks (pending ones are still being retried). */
  webhookDeliveriesMs: 90 * DAY,
  /** Per-step timings behind the metrics page (it looks back 30 days), kept longer for review. */
  nodeRunsMs: 180 * DAY,
  /** The intake log of every inbound message, accepted or rejected. */
  inboundEmailsMs: 180 * DAY,
  /** Replay receipts for signed webhooks: the signature window plus slack. */
  webhookReceiptsMs: 10 * 60_000,
} as const;

/** Deletes everything past its retention, in one batch. Returns rows deleted per table. */
export async function sweep(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const [expiredSessions, deliveries, runs, emails, receipts] = await db.batch([
    db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.tokenHash }),
    db
      .delete(webhookDeliveries)
      .where(
        and(
          lt(webhookDeliveries.createdAt, now - RETENTION.webhookDeliveriesMs),
          ne(webhookDeliveries.status, 'pending'),
        ),
      )
      .returning({ id: webhookDeliveries.id }),
    db
      .delete(nodeRuns)
      .where(lt(nodeRuns.endedAt, now - RETENTION.nodeRunsMs))
      .returning({ id: nodeRuns.nodeId }),
    db
      .delete(inboundEmails)
      .where(lt(inboundEmails.receivedAt, now - RETENTION.inboundEmailsMs))
      .returning({ id: inboundEmails.id }),
    db
      .delete(webhookReceipts)
      .where(lt(webhookReceipts.receivedAt, now - RETENTION.webhookReceiptsMs))
      .returning({ id: webhookReceipts.id }),
  ]);
  return {
    sessions: expiredSessions.length,
    webhookDeliveries: deliveries.length,
    nodeRuns: runs.length,
    inboundEmails: emails.length,
    webhookReceipts: receipts.length,
  };
}
