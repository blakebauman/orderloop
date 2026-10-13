/**
 * REST API (/api/v1). Every route is authorized by `isApiAuthorized` in workers/app.ts.
 *
 *   GET  /api/v1/flows
 *   POST /api/v1/orders                         { flowId, version?, input: OrderInput, vars? }
 *   GET  /api/v1/orders?type=&status=&q=
 *   GET  /api/v1/orders/:id                     live state from the order's agent
 *   POST /api/v1/orders/:id/events              { event: "payment.received", payload? }  (webhooks)
 *   POST /api/v1/orders/:id/approvals/:nodeId   { decision: "approved"|"rejected", by?, note? }
 *   POST /api/v1/orders/:id/cancel              { reason? }
 */

import { orderInputSchema } from '@orderloop/core';
import { z } from 'zod';
import { engine } from './env.server';
import { ensureSeeded, listFlows } from './flows.server';
import { listOrders } from './orders.server';

const startSchema = z.object({
  flowId: z.string(),
  version: z.number().int().positive().optional(),
  input: orderInputSchema,
  vars: z.record(z.string(), z.unknown()).optional(),
});

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function handleApi(request: Request): Promise<Response> {
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
    if (parts[0] !== 'orders') return json({ error: 'Not found' }, 404);

    if (parts.length === 1) {
      if (request.method === 'GET') {
        const q = url.searchParams;
        return json({
          orders: await listOrders({
            type: q.get('type') ?? undefined,
            status: q.get('status') ?? undefined,
            q: q.get('q') ?? undefined,
          }),
        });
      }
      if (request.method === 'POST') {
        const parsed = startSchema.safeParse(await body());
        if (!parsed.success)
          return json({ error: 'Invalid order', issues: parsed.error.issues }, 400);
        await ensureSeeded();
        return json(await engine().startOrder(parsed.data), 201);
      }
    }

    const orderId = parts[1]!;
    if (parts.length === 2 && request.method === 'GET') {
      const s = await engine().snapshot(orderId);
      return s ? json(s) : json({ error: 'Not found' }, 404);
    }
    if (parts[2] === 'events' && request.method === 'POST') {
      const b = (await body()) as { event?: string; payload?: Record<string, unknown> };
      if (!b.event) return json({ error: '`event` is required' }, 400);
      return json(await engine().sendEvent(orderId, b.event, b.payload ?? {}));
    }
    if (parts[2] === 'approvals' && parts[3] && request.method === 'POST') {
      const b = (await body()) as { decision?: string; by?: string; note?: string };
      if (b.decision !== 'approved' && b.decision !== 'rejected')
        return json({ error: '`decision` must be approved or rejected' }, 400);
      await engine().decide(orderId, parts[3], b.decision, b.by ?? 'api', b.note);
      return json({ ok: true });
    }
    if (parts[2] === 'cancel' && request.method === 'POST') {
      const b = (await body()) as { reason?: string };
      await engine().cancel(orderId, b.reason ?? 'Cancelled via API');
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
