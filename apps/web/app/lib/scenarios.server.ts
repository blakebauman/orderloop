import { redirect } from 'react-router';
import { audit } from './audit.server';
import type { Caller } from './auth.server';
import { engine } from './env.server';
import { ensureSeeded } from './flows.server';
import { demoAvailable, publishedFlows } from './orders.server';
import { SCENARIOS } from './scenarios';

/**
 * Starts a demo scenario's order, simulated failure and all, and redirects to it. The scenario
 * comes from the server's list by id, so a form can't smuggle a simulated failure into a real
 * order; and only where the demo data is loaded.
 */
export async function startScenario(request: Request, me: Caller, id: string) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s || !(await demoAvailable()))
    return { id, error: 'That demo scenario no longer exists. Reload the page.' };
  await ensureSeeded();
  if (!(await publishedFlows()).some((f) => f.id === s.flowId))
    return { id, error: 'Its flow is not published. Publish it on the Flows page first.' };
  try {
    const { orderId } = await engine().startOrder({
      flowId: s.flowId,
      input: s.input,
      startedBy: me.id,
    });
    await audit(request, 'order.started', {
      actor: me,
      target: orderId,
      detail: { flowId: s.flowId, scenario: s.id, via: 'app' },
    });
    return redirect(`/orders/${orderId}`);
  } catch (err) {
    console.error('scenario start failed', err);
    return { id, error: 'The engine did not accept the order. Try again in a moment.' };
  }
}
