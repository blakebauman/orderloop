import type { BusinessAuditAction } from '@orderloop/core';
import { data } from 'react-router';
import { audit } from '~/lib/audit.server';
import { actor, requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { decider, signedActor } from '~/lib/principal.server';
import type { Route } from './+types/order-action';

/** Form posts from pages without a live agent connection (approvals inbox, Commerce). */
export async function action({ request, params }: Route.ActionArgs) {
  const f = await request.formData();
  const intent = String(f.get('intent'));
  // Deciding needs approver; delivering events, restarting and cancelling need operator.
  const me = await requireUser(
    request,
    intent === 'approve' || intent === 'reject' ? 'approver' : 'operator',
  );
  const record = (action: BusinessAuditAction, detail: Record<string, unknown>, target?: string) =>
    audit(request, action, {
      actor: me,
      target: target ?? params.orderId,
      detail: { ...detail, via: 'app' },
    });
  try {
    if (intent === 'approve' || intent === 'reject') {
      const nodeId = String(f.get('nodeId'));
      const decision = intent === 'approve' ? 'approved' : 'rejected';
      const note = String(f.get('note') ?? '') || undefined;
      const res = await engine().decide(
        params.orderId,
        nodeId,
        decision,
        await signedActor(decider(me, actor(me)), `decide:${params.orderId}`),
        note,
      );
      if (!res.ok)
        return data(
          {
            ok: false,
            error:
              res.reason === 'own_order' || res.reason === 'forbidden'
                ? res.error
                : res.reason === 'not_found'
                  ? 'That order no longer exists'
                  : 'That step is no longer waiting for a decision',
          },
          {
            status: { own_order: 403, forbidden: 403, not_found: 404, not_waiting: 409 }[
              res.reason
            ],
          },
        );
      await record('approval.decided', { nodeId, decision, ...(note ? { note } : {}) });
      return { ok: true };
    }
    if (intent === 'event') {
      const event = String(f.get('event'));
      const res = await engine().sendEvent(params.orderId, event, { source: 'commerce' });
      if (res.delivered) await record('order.event_delivered', { event, nodeId: res.nodeId });
      return { ok: true, ...res };
    }
    if (intent === 'restart') {
      // A fresh order with the same customer and lines, on the flow's current version. Demo
      // failure switches are dropped so the retry runs for real.
      const prev = await engine().snapshot(params.orderId);
      if (!prev?.order || !prev.flow) throw new Error('That order no longer exists');
      const { simulate: _simulate, ...meta } = prev.order.meta ?? {};
      const { orderId } = await engine().startOrder({
        flowId: prev.flow.id,
        input: {
          model: prev.order.model,
          channel: prev.order.channel,
          contact: prev.order.contact,
          fulfillment: prev.order.fulfillment,
          title: prev.order.title,
          customerId: prev.order.customerId,
          currency: prev.order.currency,
          lines: prev.order.lines.map(({ sku, qty }) => ({ sku, qty })),
          documentText: prev.order.documentText,
          documentKey: prev.order.documentKey,
          meta: { ...meta, restartedFrom: params.orderId },
        },
        startedBy: me.id,
      });
      await record(
        'order.started',
        { flowId: prev.flow.id, restartedFrom: params.orderId },
        orderId,
      );
      return { ok: true, orderId };
    }
    if (intent === 'cancel') {
      const reason = String(f.get('reason') ?? 'Cancelled by operator');
      const res = await engine().cancel(params.orderId, reason);
      if (!res.ok)
        return data(
          {
            ok: false,
            error:
              res.reason === 'not_found'
                ? 'That order no longer exists'
                : 'The order has already finished',
          },
          { status: res.reason === 'not_found' ? 404 : 409 },
        );
      await record('order.cancelled', { reason });
      return { ok: true };
    }
  } catch (err) {
    return data({ ok: false, error: friendlyError(intent, err) }, { status: 400 });
  }
  return data({ ok: false, error: 'Unknown intent' }, { status: 400 });
}

/** Engine errors in operator words, keeping the engine's text as the detail. */
function friendlyError(intent: string, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  if (/not waiting/i.test(detail))
    return 'This approval was already decided or has timed out. Refresh to see where the order is now.';
  const what =
    intent === 'event'
      ? 'Could not deliver the event'
      : intent === 'cancel'
        ? 'Could not cancel the order'
        : intent === 'restart'
          ? 'Could not start the new order'
          : 'Could not record the decision';
  return `${what}. ${detail}`;
}
