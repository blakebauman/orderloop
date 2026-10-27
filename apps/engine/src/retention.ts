/**
 * Retention: a daily sweep (the Worker's cron trigger) that deletes rows nothing reads once they
 * are old. Orders and everything that is part of an order's record (payments, shipments, the stock
 * and balance ledgers, flow versions) are kept. Audit events past the deployment's retention
 * (`AUDIT_RETENTION_DAYS`, 400 days unless set) are archived to R2 first, then deleted. Where a
 * deployment sets `PERSONAL_DATA_RETENTION_DAYS`, orders finished longer ago than that lose their
 * buyer's personal data, as an erasure request would remove it (`eraseOrders`); the commercial
 * record stays. Stored secrets are resealed under the current `DATA_KEY` (`resealSecrets`).
 */

import {
  auditRetentionDays,
  FINAL_CART_STATUSES,
  personalDataRetentionDays,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import {
  auditEvents,
  carts,
  checkoutSessions,
  createDb,
  inboundEmails,
  nodeRuns,
  orders,
  paymentEvents,
  sessions,
  ucpIdempotency,
  webhookDeliveries,
  webhookReceipts,
} from '@orderloop/db';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { pruneConfirmations } from './confirmations';
import { resealSecrets } from './data-key';
import { cartAgent } from './namespaces';
import { eraseIfErased, eraseOrders } from './subjects';
import { pruneUsage } from './usage';

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
  /** Handled Stripe event ids: Stripe redelivers for three days; kept well past that. */
  paymentEventsMs: 30 * DAY,
  /** UCP Idempotency-Key replays: UCP asks for 24 hours and recommends 48. */
  ucpIdempotencyMs: 2 * DAY,
  /**
   * Checkout sessions that never placed an order, after they expired. One that did is part of
   * its order's record (its line ids and ship-to are what the platform's order events show).
   */
  abandonedCheckoutsMs: 30 * DAY,
  /**
   * Chat, files, return forms and buyers of carts that ended (submitted, returned or canceled)
   * this long ago (`CartAgent.purge`). The cart's lines, quote and order stay.
   */
  endedCartsMs: 90 * DAY,
} as const;

/** Deletes everything past its retention, in one batch. Returns rows deleted per table. */
export async function sweep(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const [expiredSessions, deliveries, runs, emails, receipts, events, replays, checkouts] =
    await db.batch([
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
      db
        .delete(paymentEvents)
        .where(lt(paymentEvents.receivedAt, now - RETENTION.paymentEventsMs))
        .returning({ id: paymentEvents.id }),
      db
        .delete(ucpIdempotency)
        .where(lt(ucpIdempotency.createdAt, now - RETENTION.ucpIdempotencyMs))
        .returning({ key: ucpIdempotency.key }),
      db
        .delete(checkoutSessions)
        .where(
          and(
            isNull(checkoutSessions.orderId),
            lt(checkoutSessions.expiresAt, now - RETENTION.abandonedCheckoutsMs),
          ),
        )
        .returning({ id: checkoutSessions.id }),
    ]);
  return {
    auditArchived: await archiveAudit(env, now),
    cartsPurged: await purgeEndedCarts(env, now),
    cartBuyersIndexed: await indexCartBuyers(env),
    personalDataErased: await expirePersonalData(env, now),
    confirmations: await pruneConfirmations(env, now),
    aiUsageDays: await pruneUsage(env, now),
    secrets: await resealSecrets(env),
    sessions: expiredSessions.length,
    webhookDeliveries: deliveries.length,
    nodeRuns: runs.length,
    inboundEmails: emails.length,
    webhookReceipts: receipts.length,
    paymentEvents: events.length,
    ucpIdempotency: replays.length,
    abandonedCheckouts: checkouts.length,
  };
}

/** Ended carts one sweep clears; the rest wait for the next day's. */
const PURGE_MAX = 200;

/** Clears the chat, files and buyer of carts that ended past their retention. Returns how many. */
export async function purgeEndedCarts(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const due = await db
    .select({ id: carts.id })
    .from(carts)
    .where(
      and(
        isNull(carts.purgedAt),
        inArray(carts.status, [...FINAL_CART_STATUSES]),
        lt(carts.updatedAt, now - RETENTION.endedCartsMs),
      ),
    )
    .orderBy(asc(carts.updatedAt))
    .limit(PURGE_MAX);
  let purged = 0;
  for (const c of due) {
    const r = await cartAgent(env, c.id).purge();
    if (r.purged) purged++;
  }
  return purged;
}

/** External carts one sweep re-indexes; the rest wait for the next day's. */
const BACKFILL_MAX = 200;

/**
 * Records the buyer of external carts opened before `carts.buyer_id` existed (migration 0050), so
 * a data subject request finds them: each cart's agent writes its row again. Once every row has
 * been indexed this finds nothing (an erased or purged buyer is indexed as '').
 */
export async function indexCartBuyers(env: Env) {
  const db = createDb(env.DB);
  const due = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(isNotNull(carts.pluginId), isNull(carts.buyerId)))
    .limit(BACKFILL_MAX);
  let indexed = 0;
  for (const c of due) {
    try {
      if (await cartAgent(env, c.id).reindex()) {
        indexed++;
        // Someone erased before this cart named them is erased from it now.
        const row = await db
          .select({ buyerId: carts.buyerId })
          .from(carts)
          .where(eq(carts.id, c.id))
          .get();
        if (row?.buyerId) await eraseIfErased(env, c.id, row.buyerId);
      }
      // A row whose agent holds nothing has no buyer to find: mark it done.
      else
        await db
          .update(carts)
          .set({ buyerId: '' })
          .where(and(eq(carts.id, c.id), isNull(carts.buyerId)));
    } catch (e) {
      // One cart that can't answer waits for the next sweep; the rest of the sweep goes on.
      console.error(JSON.stringify({ type: 'cart_reindex_failed', id: c.id, error: String(e) }));
    }
  }
  return indexed;
}

/** Audit events per archive object, and the most one sweep moves. */
const ARCHIVE_BATCH = 1000;
const ARCHIVE_MAX = 50_000;

/**
 * Where an archive of audit events goes in the R2 bucket: named by its first event and how many
 * it holds, which together name the same events, since a batch is read in a fixed order.
 */
export const auditArchiveKey = (first: { at: number; id: string }, count: number) =>
  `audit/${new Date(first.at).toISOString().slice(0, 10)}/${first.at}-${first.id}-${count}.ndjson`;

/**
 * Moves audit events past the retention to R2, one NDJSON object (one event a line, hashes and
 * all) per batch, deleting each batch only once its object is written. Sealed events go in chain
 * order and stop at the first one still inside the retention, so what stays is an unbroken chain;
 * events from before the chain go by time. A batch whose object is already there (written by a
 * sweep that stopped before its delete) is only deleted: the bucket locks audit/ (provision.sh),
 * so that object can't be written again. Returns how many moved.
 */
export async function archiveAudit(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const cutoff = now - auditRetentionDays(env.AUDIT_RETENTION_DAYS) * DAY;
  let moved = 0;
  const put = async (rows: (typeof auditEvents.$inferSelect)[]) => {
    const key = auditArchiveKey(rows[0]!, rows.length);
    if (await env.DOCS.head(key)) return;
    await env.DOCS.put(key, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, {
      httpMetadata: { contentType: 'application/x-ndjson' },
      customMetadata: { events: String(rows.length) },
    });
  };

  while (moved < ARCHIVE_MAX) {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(isNull(auditEvents.seq), lt(auditEvents.at, cutoff)))
      .orderBy(asc(auditEvents.at), asc(auditEvents.id))
      .limit(ARCHIVE_BATCH);
    if (!rows.length) break;
    await put(rows);
    const last = rows.at(-1)!;
    await db
      .delete(auditEvents)
      .where(
        and(
          isNull(auditEvents.seq),
          or(
            lt(auditEvents.at, last.at),
            and(eq(auditEvents.at, last.at), lte(auditEvents.id, last.id)),
          ),
        ),
      );
    moved += rows.length;
    if (rows.length < ARCHIVE_BATCH) break;
  }

  while (moved < ARCHIVE_MAX) {
    const batch = await db
      .select()
      .from(auditEvents)
      .where(isNotNull(auditEvents.seq))
      .orderBy(asc(auditEvents.seq))
      .limit(ARCHIVE_BATCH);
    const old = batch.findIndex((r) => r.at >= cutoff);
    const rows = old === -1 ? batch : batch.slice(0, old);
    if (!rows.length) break;
    await put(rows);
    await db.delete(auditEvents).where(lte(auditEvents.seq, rows.at(-1)!.seq!));
    moved += rows.length;
    if (rows.length < batch.length || batch.length < ARCHIVE_BATCH) break;
  }
  return moved;
}

/** Orders whose buyer one sweep erases; the rest wait for the next day's. */
const EXPIRE_MAX = 500;

/** Erases the buyer from orders finished before the deployment's retention. Returns how many. */
export async function expirePersonalData(env: Env, now = Date.now()) {
  const days = personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS);
  if (days === null) return 0;
  const due = await createDb(env.DB)
    .select({ id: orders.id, title: orders.title })
    .from(orders)
    .where(
      and(
        isNull(orders.erasedAt),
        inArray(orders.status, TERMINAL_ORDER_STATUSES),
        lt(orders.updatedAt, now - days * DAY),
      ),
    )
    .orderBy(asc(orders.updatedAt))
    .limit(EXPIRE_MAX);
  const r = await eraseOrders(env, due, []);
  // Terminal in the index but running in its agent: skipped, and tried again tomorrow.
  if (r.refused.length)
    console.warn(JSON.stringify({ type: 'personal_data_retention_skipped', orders: r.refused }));
  return r.orders;
}
