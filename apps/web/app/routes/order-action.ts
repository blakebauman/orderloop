import { data } from 'react-router';
import { actor, requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import type { Route } from './+types/order-action';

/** Form posts from pages without a live agent connection (approvals inbox, back office). */
export async function action({ request, params }: Route.ActionArgs) {
  await requireUser(request);
  const f = await request.formData();
  const intent = String(f.get('intent'));
  try {
    if (intent === 'approve' || intent === 'reject') {
      await engine().decide(
        params.orderId,
        String(f.get('nodeId')),
        intent === 'approve' ? 'approved' : 'rejected',
        actor(request),
        String(f.get('note') ?? '') || undefined,
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
    if (intent === 'cancel') {
      await engine().cancel(params.orderId, String(f.get('reason') ?? 'Cancelled by operator'));
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
    return 'This approval was already decided or has escalated. Refresh to see where the order is now.';
  const what =
    intent === 'event'
      ? 'Could not deliver the event'
      : intent === 'cancel'
        ? 'Could not cancel the order'
        : 'Could not record the decision';
  return `${what}. ${detail}`;
}
