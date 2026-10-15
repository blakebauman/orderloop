import { data } from 'react-router';
import { actor, requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import type { Route } from './+types/order-action';

/** Form posts from pages without a live agent connection (approvals inbox, back office). */
export async function action({ request, params }: Route.ActionArgs) {
  const f = await request.formData();
  const intent = String(f.get('intent'));
  // Deciding needs approver; delivering events, restarting and cancelling need operator.
  const me = await requireUser(
    request,
    intent === 'approve' || intent === 'reject' ? 'approver' : 'operator',
  );
  try {
    if (intent === 'approve' || intent === 'reject') {
      const res = await engine().decide(
        params.orderId,
        String(f.get('nodeId')),
        intent === 'approve' ? 'approved' : 'rejected',
        actor(me),
        me.id,
        String(f.get('note') ?? '') || undefined,
      );
      if (!res.ok)
        return data(
          {
            ok: false,
            error:
              res.reason === 'own_order'
                ? res.error
                : res.reason === 'not_found'
                  ? 'That order no longer exists'
                  : 'That step is no longer waiting for a decision',
          },
          { status: { own_order: 403, not_found: 404, not_waiting: 409 }[res.reason] },
        );
      return { ok: true };
    }
    if (intent === 'event') {
      return {
        ok: true,
        ...(await engine().sendEvent(params.orderId, String(f.get('event')), {
          source: 'back-office',
        })),
      };
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
      return { ok: true, orderId };
    }
    if (intent === 'cancel') {
      const res = await engine().cancel(
        params.orderId,
        String(f.get('reason') ?? 'Cancelled by operator'),
      );
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
