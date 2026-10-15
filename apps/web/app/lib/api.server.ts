/**
 * REST API (/api/v1). workers/app.ts resolves the caller (`apiPrincipal`); each route here checks
 * its role: reads need viewer, approval decisions approver, everything else operator.
 *
 *   GET  /api/v1/flows
 *   POST /api/v1/orders                         { flowId, version?, input: OrderInput, vars? }
 *                                               Idempotency-Key header: a repeat returns 200 + the same order,
 *                                               422 if the body differs
 *   GET  /api/v1/orders?model=&channel=&status=&q=&limit=&cursor=   newest first; { orders, nextCursor }
 *   GET  /api/v1/orders/:id                     live state from the order's agent
 *   POST /api/v1/orders/:id/events              { event: "payment.received", payload? }  (404 unknown order)
 *   POST /api/v1/orders/:id/approvals/:nodeId   { decision: "approved"|"rejected", by?, note? }  (409 not waiting)
 *   POST /api/v1/orders/:id/cancel              { reason? }  (409 already finished)
 *
 *   GET    /api/v1/audit-events                 ?type=auth|team|token|api|oauth|integration&before=<ms>&limit=  (operator)
 *
 *   GET    /api/v1/webhook-subscriptions
 *   POST   /api/v1/webhook-subscriptions        { url, events?: ["order.shipped", …] | ["*"] }
 *   DELETE /api/v1/webhook-subscriptions/:id
 *   GET    /api/v1/webhook-subscriptions/:id/deliveries
 *
 *   GET    /api/v1/integrations                 signing keys for external systems (operator)
 *   POST   /api/v1/integrations                 { name, events?, startOrders?, flows?, channel? } → secret, once
 *   POST   /api/v1/integrations/:id/rotate      new secret; the old one works for 24 hours
 *   DELETE /api/v1/integrations/:id             revoke
 *
 * Signed webhooks (an integration's key, no token; see `readSigned`):
 *   POST /api/v1/webhooks/events                { orderId, event, payload? }
 *   POST /api/v1/webhooks/orders                { model, channel, externalId, lines, … }
 *
 * Stripe's webhook (Stripe-Signature with STRIPE_WEBHOOK_SECRET; see ./stripe.server.ts):
 *   POST /api/v1/webhooks/stripe                invoice.paid, payment_intent.canceled, charge.dispute.created
 *
 * Channel adapters:
 *   POST /api/v1/channels/shopify/orders         Shopify orders/create webhook (X-Shopify-Hmac-Sha256)
 *   POST /api/v1/channels/edi/850                raw X12 850 interchange (operator; EDI_PARTNERS)
 */

import { env } from 'cloudflare:workers';
import {
  type AuditActor,
  type AuditVia,
  allowsEvent,
  allowsOrder,
  atLeast,
  flowForOrder,
  type InboundOrder,
  inboundFingerprint,
  inboundOrderSchema,
  type Principal,
  parseEdiPartners,
  parseOrderRoutes,
  parseX12,
  type Role,
  type ShopifyOrder,
  SIGNATURE_HEADER,
  shopifyToInbound,
  signatureKeyId,
  startOrderSchema,
  toStartRequest,
  verificationSecrets,
  verifyShopifyHmac,
  verifyWebhook,
  x12850ToInbound,
} from '@orderloop/core';
import { webhookReceipts } from '@orderloop/db';
import { eq, lt } from 'drizzle-orm';
import type { z } from 'zod';
import {
  cancelInput,
  decisionInput,
  eventSchema,
  integrationInput,
  orderEventInput,
  subscriptionInput,
} from './api-schemas';
import { isAuditGroup } from './audit';
import { audit, listAudit } from './audit.server';
import { actor, forbidden } from './auth.server';
import { BodyTooLarge, MAX_EDI_BYTES, readText, tooLarge } from './body';
import { decodeCursor, encodeCursor } from './cursor';
import { db, engine } from './env.server';
import { ensureSeeded, listFlows } from './flows.server';
import {
  createIntegration,
  findIntegration,
  type Integration,
  listIntegrations,
  orderChannel,
  revokeIntegration,
  rotateIntegration,
  touchIntegration,
} from './integrations.server';
import { currencies, customerIdByEmail, listOrders } from './orders.server';
import { overBudget } from './rate-limit';
import {
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listSubscriptions,
} from './webhooks.server';

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Purchase orders of one X12 interchange started at the same time. */
const EDI_CONCURRENCY = 4;

/** The most orders one page of GET /api/v1/orders returns. */
const MAX_PAGE = 200;

export async function handleApi(request: Request, caller: Principal): Promise<Response> {
  // Reads need viewer; approvals need approver; anything else that changes state needs operator.
  const need = (min: Role) =>
    atLeast(caller.role, min) ? null : json({ error: forbidden(min) }, 403);
  const url = new URL(request.url);
  const parts = url.pathname
    .replace(/^\/api\/v1\/?/, '')
    .split('/')
    .filter(Boolean);
  const body = async (): Promise<unknown> => {
    if (request.method !== 'POST') return {};
    try {
      return JSON.parse(await readText(request));
    } catch (err) {
      if (err instanceof BodyTooLarge) throw err;
      return {};
    }
  };
  try {
    if (parts[0] === 'flows' && parts.length === 1 && request.method === 'GET') {
      return json({ flows: await listFlows() });
    }
    if (parts[0] === 'audit-events' && parts.length === 1 && request.method === 'GET') {
      const denied = need('admin');
      if (denied) return denied;
      const q = url.searchParams;
      const type = q.get('type');
      return json({
        events: await listAudit({
          group: isAuditGroup(type) ? type : undefined,
          before: Number(q.get('before')) || undefined,
          limit: Number(q.get('limit')) || 100,
        }),
      });
    }
    if (parts[0] === 'channels' && parts[1] === 'edi' && parts[2] === '850') {
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      return (
        need('operator') ??
        (await handleEdi850(await readText(request, MAX_EDI_BYTES), {
          request,
          actor: caller,
          via: 'api',
        }))
      );
    }
    if (parts[0] === 'webhook-subscriptions')
      return need('admin') ?? (await handleSubscriptions(request, caller, parts, body));
    if (parts[0] === 'integrations')
      return need('admin') ?? (await handleIntegrations(request, caller, parts, body));
    if (parts[0] !== 'orders') return json({ error: 'Not found' }, 404);

    if (parts.length === 1) {
      if (request.method === 'GET') {
        const q = url.searchParams;
        const after = decodeCursor(q.get('cursor'));
        if (q.get('cursor') && !after) return json({ error: 'Invalid cursor' }, 400);
        const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), MAX_PAGE);
        const page = await listOrders(
          {
            model: q.get('model') ?? undefined,
            channel: q.get('channel') ?? undefined,
            status: q.get('status') ?? undefined,
            q: q.get('q') ?? undefined,
            after: after ?? undefined,
          },
          limit,
        );
        const last = page.at(-1);
        return json({
          orders: page,
          nextCursor: page.length === limit && last ? encodeCursor(last) : null,
        });
      }
      if (request.method === 'POST') {
        const denied = need('operator');
        if (denied) return denied;
        const parsed = startOrderSchema.safeParse(await body());
        if (!parsed.success)
          return json({ error: 'Invalid order', issues: parsed.error.issues }, 400);
        const idempotencyKey = request.headers.get('idempotency-key')?.trim() || undefined;
        if (idempotencyKey && idempotencyKey.length > 255)
          return json({ error: 'Idempotency-Key must be at most 255 characters' }, 400);
        if (!(await currencies()).some((c) => c.currency === parsed.data.input.currency))
          return json(
            {
              error: `Unsupported currency ${parsed.data.input.currency}; there is no exchange rate for it`,
            },
            400,
          );
        await ensureSeeded();
        const start = { ...parsed.data, startedBy: caller.id };
        const res = idempotencyKey
          ? await engine().startOrderOnce({ ...start, idempotencyKey })
          : await engine().startOrder(start);
        if ('mismatch' in res)
          return json({ error: 'Idempotency-Key was already used with a different request' }, 422);
        if (!res.replayed)
          await audit(request, 'order.started', {
            actor: caller,
            target: res.orderId,
            detail: { flowId: parsed.data.flowId, via: 'api' },
          });
        return json(res, res.replayed ? 200 : 201);
      }
    }

    const orderId = parts[1]!;
    if (parts.length === 2 && request.method === 'GET') {
      const s = await engine().snapshot(orderId);
      return s ? json(s) : json({ error: 'Not found' }, 404);
    }
    if (parts[2] === 'events' && request.method === 'POST') {
      const denied = need('operator');
      if (denied) return denied;
      const b = orderEventInput.safeParse(await body());
      if (!b.success) return json({ error: 'Invalid event', issues: b.error.issues }, 400);
      const res = await engine().sendEvent(orderId, b.data.event, b.data.payload ?? {});
      if (res.notFound) return json({ error: 'Not found' }, 404);
      if (res.delivered)
        await audit(request, 'order.event_delivered', {
          actor: caller,
          target: orderId,
          detail: { event: b.data.event, nodeId: res.nodeId, via: 'api' },
        });
      return json(res);
    }
    if (parts[2] === 'approvals' && parts[3] && request.method === 'POST') {
      const denied = need('approver');
      if (denied) return denied;
      const parsed = decisionInput.safeParse(await body());
      if (!parsed.success)
        return json({ error: 'Invalid decision', issues: parsed.error.issues }, 400);
      const b = parsed.data;
      const res = await engine().decide(
        orderId,
        parts[3],
        b.decision,
        actor(caller),
        caller.id,
        b.note,
      );
      if (res.ok) {
        await audit(request, 'approval.decided', {
          actor: caller,
          target: orderId,
          detail: {
            nodeId: parts[3],
            decision: b.decision,
            ...(b.note ? { note: b.note } : {}),
            via: 'api',
          },
        });
        return json(res);
      }
      if (res.reason === 'own_order') return json({ error: res.error }, 403);
      return res.reason === 'not_found'
        ? json({ error: 'Not found' }, 404)
        : json({ error: `${parts[3]} is not waiting for an approval` }, 409);
    }
    if (parts[2] === 'cancel' && request.method === 'POST') {
      const denied = need('operator');
      if (denied) return denied;
      const b = cancelInput.safeParse(await body());
      if (!b.success) return json({ error: 'Invalid cancel', issues: b.error.issues }, 400);
      const reason = b.data.reason ?? 'Cancelled via API';
      const res = await engine().cancel(orderId, reason);
      if (res.ok) {
        await audit(request, 'order.cancelled', {
          actor: caller,
          target: orderId,
          detail: { reason, via: 'api' },
        });
        return json(res);
      }
      return res.reason === 'not_found'
        ? json({ error: 'Not found' }, 404)
        : json({ error: 'The order has already finished' }, 409);
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return failure(err);
  }
}

/** A 413 for an oversized body; anything else is logged and answered without its internals. */
function failure(err: unknown): Response {
  if (err instanceof BodyTooLarge) return tooLarge(err);
  console.error('api error', err);
  return json({ error: 'Internal error' }, 500);
}

async function handleSubscriptions(
  request: Request,
  caller: Principal,
  parts: string[],
  body: () => Promise<unknown>,
): Promise<Response> {
  if (parts.length === 1 && request.method === 'GET')
    return json({ subscriptions: await listSubscriptions() });
  if (parts.length === 1 && request.method === 'POST') {
    const parsed = subscriptionInput.safeParse(await body());
    if (!parsed.success)
      return json({ error: 'Invalid subscription', issues: parsed.error.issues }, 400);
    const created = await createSubscription(parsed.data);
    await audit(request, 'webhook.subscribed', {
      actor: caller,
      target: parsed.data.url,
      detail: { id: created.subscription.id, events: parsed.data.events, via: 'api' },
    });
    return json(created, 201);
  }
  const id = parts[1]!;
  if (parts.length === 2 && request.method === 'DELETE') {
    if (!(await deleteSubscription(id))) return json({ error: 'Not found' }, 404);
    await audit(request, 'webhook.unsubscribed', {
      actor: caller,
      target: id,
      detail: { via: 'api' },
    });
    return json({ ok: true });
  }
  if (parts[2] === 'deliveries' && parts.length === 3 && request.method === 'GET')
    return json({ deliveries: await listDeliveries(id) });
  return json({ error: 'Not found' }, 404);
}

async function handleIntegrations(
  request: Request,
  caller: Principal,
  parts: string[],
  body: () => Promise<unknown>,
): Promise<Response> {
  if (parts.length === 1 && request.method === 'GET')
    return json({ integrations: await listIntegrations() });
  if (parts.length === 1 && request.method === 'POST') {
    const parsed = integrationInput.safeParse(await body());
    if (!parsed.success)
      return json({ error: 'Invalid integration', issues: parsed.error.issues }, 400);
    const created = await createIntegration(parsed.data, actor(caller));
    await audit(request, 'integration.created', {
      actor: caller,
      target: created.integration.name,
      detail: { id: created.integration.id },
    });
    return json(created, 201);
  }
  const id = parts[1]!;
  if (parts.length === 3 && parts[2] === 'rotate' && request.method === 'POST') {
    const rotated = await rotateIntegration(id);
    if (!rotated) return json({ error: 'Not found' }, 404);
    await audit(request, 'integration.rotated', {
      actor: caller,
      target: rotated.integration.name,
      detail: { id },
    });
    return json(rotated);
  }
  if (parts.length === 2 && request.method === 'DELETE') {
    const revoked = await revokeIntegration(id);
    if (!revoked) return json({ error: 'Not found' }, 404);
    await audit(request, 'integration.revoked', {
      actor: caller,
      target: revoked.name,
      detail: { id },
    });
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}

/**
 * The verified body of a signed webhook and the integration that signed it, or the response
 * refusing it. The signature (`X-OrderLoop-Signature: t=…,k=<integration>,v1=…`) is an HMAC of
 * the raw body with that integration's secret, or its previous one during a rotation.
 */
async function readSigned(
  request: Request,
): Promise<{ raw: string; signature: string; integration: Integration } | { refused: Response }> {
  let raw: string;
  try {
    raw = await readText(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) return { refused: tooLarge(err) };
    throw err;
  }
  const header = request.headers.get(SIGNATURE_HEADER);
  const keyId = signatureKeyId(header);
  if (!keyId) return { refused: json({ error: 'Signature must name its integration (k=)' }, 401) };
  const integration = await findIntegration(keyId);
  if (!integration) return { refused: json({ error: 'Unknown or revoked integration' }, 401) };
  const check = await verifyWebhook(verificationSecrets(integration), raw, header);
  if (!check.ok) return { refused: json({ error: check.reason }, 401) };
  const limited = await overBudget('WEBHOOK_LIMIT', integration.id);
  if (limited) return { refused: limited };
  await touchIntegration(integration.id);
  return { raw, signature: /v1=([0-9a-f]+)/i.exec(header ?? '')?.[1] ?? '', integration };
}

/**
 * Signed business events from external systems, within their integration's scope. Answers 409
 * when no node is waiting for the event yet, so a sender's retry policy delivers it later.
 */
export async function handleSignedEvent(request: Request): Promise<Response> {
  const signed = await readSigned(request);
  if ('refused' in signed) return signed.refused;
  let parsed: z.infer<typeof eventSchema>;
  try {
    parsed = eventSchema.parse(JSON.parse(signed.raw));
  } catch {
    return json({ error: 'Body must be { orderId, event, payload? }' }, 400);
  }
  // A channel-bound key only reaches its channel's orders; an order it can't see is not found.
  const channel = signed.integration.channel ? await orderChannel(parsed.orderId) : 'any';
  if (channel === null) return json({ error: 'Not found' }, 404);
  const scope = allowsEvent(signed.integration, parsed.event, channel);
  if (!scope.ok) return json({ error: scope.reason }, 403);
  // Claim the signature first, so a replay of this exact request (even a concurrent one) delivers
  // nothing. The claim is dropped unless the event was delivered, so a sender may retry a 409.
  const receipt = `event:${signed.integration.id}:${signed.signature}`;
  if (!(await claimReceipt(receipt))) return json({ delivered: true, duplicate: true });
  let delivered = false;
  try {
    const res = await engine().sendEvent(parsed.orderId, parsed.event, parsed.payload ?? {});
    delivered = !!res.delivered;
    if (res.notFound) return json({ error: 'Not found' }, 404);
    if (delivered)
      await audit(request, 'order.event_delivered', {
        actor: integrationActor(signed.integration),
        target: parsed.orderId,
        detail: { event: parsed.event, nodeId: res.nodeId, via: 'webhook' },
      });
    return json(res, res.delivered ? 200 : 409);
  } catch (err) {
    return failure(err);
  } finally {
    if (!delivered) await releaseReceipt(receipt);
  }
}

/** Seconds a signature stays valid (`verifyWebhook`'s tolerance), plus slack for clock skew. */
const RECEIPT_TTL_MS = 10 * 60_000;

/** Records a delivered signature; false when it was already recorded. */
async function claimReceipt(id: string): Promise<boolean> {
  const now = Date.now();
  const [row] = await db()
    .insert(webhookReceipts)
    .values({ id, receivedAt: now })
    .onConflictDoNothing()
    .returning();
  await db()
    .delete(webhookReceipts)
    .where(lt(webhookReceipts.receivedAt, now - RECEIPT_TTL_MS));
  return !!row;
}

async function releaseReceipt(id: string) {
  await db().delete(webhookReceipts).where(eq(webhookReceipts.id, id));
}

/**
 * Starts an order from a storefront, marketplace, POS or other channel. The flow comes from the
 * body's `flowId`, else `ORDER_ROUTES`, else the model's default template. A repeat of the same
 * channel and external id returns the order it already started.
 */
export async function handleSignedOrder(request: Request): Promise<Response> {
  const signed = await readSigned(request);
  if ('refused' in signed) return signed.refused;
  let body: unknown;
  try {
    body = JSON.parse(signed.raw);
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const parsed = inboundOrderSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'Invalid order', issues: parsed.error.issues }, 400);
  const scope = allowsOrder(signed.integration, parsed.data);
  if (!scope.ok) return json({ error: scope.reason }, 403);
  const r = await startInbound(parsed.data, {
    request,
    actor: integrationActor(signed.integration),
    via: 'webhook',
  });
  return json(r.body, r.status);
}

type InboundOutcome = { status: number; body: Record<string, unknown> };

/** Who an inbound order is recorded as starting it: an integration, a channel or an API caller. */
type InboundTrail = { request: Request; actor: AuditActor; via: AuditVia };

const integrationActor = (i: Integration): AuditActor => ({
  kind: 'integration',
  id: i.id,
  name: `integration:${i.name}`,
});

/**
 * Starts an inbound order, however it arrived (the signed endpoint or a channel adapter): checks
 * the currency, routes it, and starts it once per channel and external id.
 */
async function startInbound(
  o: InboundOrder,
  trail: InboundTrail,
  known?: Awaited<ReturnType<typeof currencies>>,
): Promise<InboundOutcome> {
  if (!(known ?? (await currencies())).some((c) => c.currency === o.currency))
    return {
      status: 400,
      body: { error: `Unsupported currency ${o.currency}; there is no exchange rate for it` },
    };
  const routes = parseOrderRoutes((env as { ORDER_ROUTES?: string }).ORDER_ROUTES);
  const flowId = o.flowId ?? flowForOrder(o.model, o.channel, routes);
  await ensureSeeded();
  try {
    // The engine replays a known channel and id before it looks at the flow, so a retry still
    // finds its order after the flow is unpublished or the routes change.
    const res = await engine().startOrderOnce({
      ...toStartRequest(o, flowId),
      fingerprint: await inboundFingerprint(o),
    });
    if ('mismatch' in res)
      return {
        status: 422,
        body: {
          error: `Order ${o.externalId} on ${o.channel} was already received with different contents; send events to change it`,
        },
      };
    if (res.replayed) return { status: 200, body: { ...res } };
    await audit(trail.request, 'order.started', {
      actor: trail.actor,
      target: res.orderId,
      detail: { flowId, channel: o.channel, externalId: o.externalId, via: trail.via },
    });
    return { status: 201, body: { ...res, flowId } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('has no published version'))
      return { status: 409, body: { error: `Flow ${flowId} is not published` } };
    console.error('inbound order failed', err);
    return { status: 500, body: { error: 'Internal error' } };
  }
}

/**
 * Shopify's orders/create webhook, signed with the app's client secret. Other topics are
 * acknowledged and ignored so Shopify stops retrying them.
 */
export async function handleShopifyOrder(request: Request): Promise<Response> {
  const secret = (env as { SHOPIFY_WEBHOOK_SECRET?: string }).SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'Shopify is not configured' }, 503);
  let raw: string;
  try {
    raw = await readText(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) return tooLarge(err);
    throw err;
  }
  if (!(await verifyShopifyHmac(secret, raw, request.headers.get('x-shopify-hmac-sha256'))))
    return json({ error: 'Bad signature' }, 401);
  // Shopify signs with one app secret, so the shop is the sender.
  const limited = await overBudget(
    'WEBHOOK_LIMIT',
    `shopify:${request.headers.get('x-shopify-shop-domain') ?? ''}`,
  );
  if (limited) return limited;
  const topic = request.headers.get('x-shopify-topic');
  if (topic !== 'orders/create') return json({ ignored: true, topic });
  let order: ShopifyOrder;
  try {
    order = JSON.parse(raw) as ShopifyOrder;
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const mapped = shopifyToInbound(order, { customerId: await customerIdByEmail(order.email) });
  if (!mapped.ok) return json({ error: mapped.error }, 400);
  const parsed = inboundOrderSchema.safeParse(mapped.order);
  if (!parsed.success) return json({ error: 'Invalid order', issues: parsed.error.issues }, 400);
  const shop = request.headers.get('x-shopify-shop-domain') ?? '';
  const r = await startInbound(parsed.data, {
    request,
    actor: { kind: 'channel', id: `shopify:${shop}`, name: `shopify:${shop}` },
    via: 'webhook',
  });
  return json(r.body, r.status);
}

/**
 * An X12 interchange of 850 purchase orders from a configured trading partner (EDI_PARTNERS maps
 * its ISA sender id to a customer). Each PO starts at most once; the response lists every PO.
 */
async function handleEdi850(text: string, trail: InboundTrail): Promise<Response> {
  const parsed = parseX12(text);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { sender, transactions } = parsed.interchange;
  const customerId = parseEdiPartners((env as { EDI_PARTNERS?: string }).EDI_PARTNERS)[sender];
  if (!customerId)
    return json({ error: `${sender || 'The sender'} is not a configured trading partner` }, 403);
  const known = await currencies();
  const one = async (tx: (typeof transactions)[number]) => {
    const mapped = x12850ToInbound(tx, { sender, customerId });
    if (!mapped.ok) return { control: tx.control, status: 400, error: mapped.error };
    const valid = inboundOrderSchema.safeParse(mapped.order);
    if (!valid.success)
      return { control: tx.control, status: 400, error: valid.error.issues[0]?.message };
    const r = await startInbound(valid.data, trail, known);
    return {
      control: tx.control,
      poNumber: (mapped.order.meta.edi as { poNumber: string }).poNumber,
      status: r.status,
      ...r.body,
    };
  };
  // A few purchase orders at a time, results in interchange order.
  const results: Awaited<ReturnType<typeof one>>[] = [];
  for (let i = 0; i < transactions.length; i += EDI_CONCURRENCY)
    results.push(...(await Promise.all(transactions.slice(i, i + EDI_CONCURRENCY).map(one))));
  return json({ sender, results });
}
