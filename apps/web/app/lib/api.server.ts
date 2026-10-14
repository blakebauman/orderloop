/**
 * REST API (/api/v1). workers/app.ts resolves the caller (`apiPrincipal`); each route here checks
 * its role: reads need viewer, approval decisions approver, everything else operator.
 *
 *   GET  /api/v1/flows
 *   POST /api/v1/orders                         { flowId, version?, input: OrderInput, vars? }
 *                                               Idempotency-Key header: a repeat returns 200 + the same order,
 *                                               422 if the body differs
 *   GET  /api/v1/orders?type=&status=&q=
 *   GET  /api/v1/orders/:id                     live state from the order's agent
 *   POST /api/v1/orders/:id/events              { event: "payment.received", payload? }  (webhooks)
 *   POST /api/v1/orders/:id/approvals/:nodeId   { decision: "approved"|"rejected", by?, note? }
 *   POST /api/v1/orders/:id/cancel              { reason? }
 *
 *   GET    /api/v1/audit-events                 ?type=auth|team|token|api&before=<ms>&limit=  (operator)
 *
 *   GET    /api/v1/webhook-subscriptions
 *   POST   /api/v1/webhook-subscriptions        { url, events?: ["order.shipped", …] | ["*"] }
 *   DELETE /api/v1/webhook-subscriptions/:id
 *   GET    /api/v1/webhook-subscriptions/:id/deliveries
 *
 * Signed webhooks (no password; see `handleSignedEvent`):
 *   POST /api/v1/webhooks/events                { orderId, event, payload? }
 *   POST /api/v1/webhooks/orders                { model, channel, externalId, lines, … }
 */

import { env } from 'cloudflare:workers';
import {
  atLeast,
  flowForOrder,
  inboundOrderSchema,
  type Principal,
  parseOrderRoutes,
  type Role,
  SIGNATURE_HEADER,
  startOrderSchema,
  toStartRequest,
  verifyWebhook,
} from '@orderloop/core';
import type { z } from 'zod';
import { eventSchema, subscriptionInput } from './api-schemas';
import { isAuditGroup } from './audit';
import { listAudit } from './audit.server';
import { actor, forbidden } from './auth.server';
import { engine } from './env.server';
import { ensureSeeded, listFlows } from './flows.server';
import { currencies, listOrders } from './orders.server';
import {
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listSubscriptions,
} from './webhooks.server';

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function handleApi(request: Request, caller: Principal): Promise<Response> {
  // Reads need viewer; approvals need approver; anything else that changes state needs operator.
  const need = (min: Role) =>
    atLeast(caller.role, min) ? null : json({ error: forbidden(min) }, 403);
  const url = new URL(request.url);
  const parts = url.pathname
    .replace(/^\/api\/v1\/?/, '')
    .split('/')
    .filter(Boolean);
  const body = async () =>
    request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  try {
    if (parts[0] === 'flows' && parts.length === 1 && request.method === 'GET') {
      return json({ flows: await listFlows() });
    }
    if (parts[0] === 'audit-events' && parts.length === 1 && request.method === 'GET') {
      const denied = need('operator');
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
    if (parts[0] === 'webhook-subscriptions')
      return need('operator') ?? (await handleSubscriptions(request, parts, body));
    if (parts[0] !== 'orders') return json({ error: 'Not found' }, 404);

    if (parts.length === 1) {
      if (request.method === 'GET') {
        const q = url.searchParams;
        return json({
          orders: await listOrders({
            model: q.get('model') ?? undefined,
            channel: q.get('channel') ?? undefined,
            status: q.get('status') ?? undefined,
            q: q.get('q') ?? undefined,
          }),
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
        const res = idempotencyKey
          ? await engine().startOrderOnce({ ...parsed.data, idempotencyKey })
          : await engine().startOrder(parsed.data);
        if ('mismatch' in res)
          return json({ error: 'Idempotency-Key was already used with a different request' }, 422);
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
      const b = (await body()) as { event?: string; payload?: Record<string, unknown> };
      if (!b.event) return json({ error: '`event` is required' }, 400);
      return json(await engine().sendEvent(orderId, b.event, b.payload ?? {}));
    }
    if (parts[2] === 'approvals' && parts[3] && request.method === 'POST') {
      const denied = need('approver');
      if (denied) return denied;
      const b = (await body()) as { decision?: string; by?: string; note?: string };
      if (b.decision !== 'approved' && b.decision !== 'rejected')
        return json({ error: '`decision` must be approved or rejected' }, 400);
      // A person or a named token decides; only the shared password may name someone else.
      const by = caller.kind === 'password' ? (b.by ?? 'api') : actor(caller);
      await engine().decide(orderId, parts[3], b.decision, by, b.note);
      return json({ ok: true });
    }
    if (parts[2] === 'cancel' && request.method === 'POST') {
      const denied = need('operator');
      if (denied) return denied;
      const b = (await body()) as { reason?: string };
      await engine().cancel(orderId, b.reason ?? 'Cancelled via API');
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleSubscriptions(
  request: Request,
  parts: string[],
  body: () => Promise<unknown>,
): Promise<Response> {
  if (parts.length === 1 && request.method === 'GET')
    return json({ subscriptions: await listSubscriptions() });
  if (parts.length === 1 && request.method === 'POST') {
    const parsed = subscriptionInput.safeParse(await body());
    if (!parsed.success)
      return json({ error: 'Invalid subscription', issues: parsed.error.issues }, 400);
    return json(await createSubscription(parsed.data), 201);
  }
  const id = parts[1]!;
  if (parts.length === 2 && request.method === 'DELETE')
    return (await deleteSubscription(id)) ? json({ ok: true }) : json({ error: 'Not found' }, 404);
  if (parts[2] === 'deliveries' && parts.length === 3 && request.method === 'GET')
    return json({ deliveries: await listDeliveries(id) });
  return json({ error: 'Not found' }, 404);
}

/**
 * Signed business events from external systems. Authenticated by an HMAC of the raw body with
 * WEBHOOK_SECRET (`X-OrderLoop-Signature: t=…,v1=…`), not the admin password. Answers 409 when no
 * node is waiting for the event yet, so a sender's retry policy delivers it later.
 */
/** The verified body of a signed webhook, or the response refusing it. */
async function readSigned(request: Request): Promise<{ raw: string } | { refused: Response }> {
  const secret = (env as { WEBHOOK_SECRET?: string }).WEBHOOK_SECRET;
  if (!secret) return { refused: json({ error: 'Webhooks are not configured' }, 503) };
  const raw = await request.text();
  const check = await verifyWebhook(secret, raw, request.headers.get(SIGNATURE_HEADER));
  return check.ok ? { raw } : { refused: json({ error: check.reason }, 401) };
}

export async function handleSignedEvent(request: Request): Promise<Response> {
  const signed = await readSigned(request);
  if ('refused' in signed) return signed.refused;
  let parsed: z.infer<typeof eventSchema>;
  try {
    parsed = eventSchema.parse(JSON.parse(signed.raw));
  } catch {
    return json({ error: 'Body must be { orderId, event, payload? }' }, 400);
  }
  try {
    const res = await engine().sendEvent(parsed.orderId, parsed.event, parsed.payload ?? {});
    return json(res, res.delivered ? 200 : 409);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
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
  const o = parsed.data;
  if (!(await currencies()).some((c) => c.currency === o.currency))
    return json(
      { error: `Unsupported currency ${o.currency}; there is no exchange rate for it` },
      400,
    );
  const routes = parseOrderRoutes((env as { ORDER_ROUTES?: string }).ORDER_ROUTES);
  const flowId = o.flowId ?? flowForOrder(o.model, o.channel, routes);
  await ensureSeeded();
  try {
    // The engine replays a known channel and id before it looks at the flow, so a retry still
    // finds its order after the flow is unpublished or the routes change.
    const res = await engine().startOrderOnce(toStartRequest(o, flowId));
    if ('mismatch' in res)
      return json(
        {
          error: `Order ${o.externalId} on ${o.channel} was already received with different contents; send events to change it`,
        },
        422,
      );
    return res.replayed ? json(res) : json({ ...res, flowId }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('has no published version'))
      return json({ error: `Flow ${flowId} is not published` }, 409);
    return json({ error: message }, 500);
  }
}
