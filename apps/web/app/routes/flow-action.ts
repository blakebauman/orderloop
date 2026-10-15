import { data } from 'react-router';
import { audit } from '~/lib/audit.server';
import { actor, requireUser } from '~/lib/auth.server';
import { BodyTooLarge, readText } from '~/lib/body';
import { engine } from '~/lib/env.server';
import { getFlow, parseFlow, publish, sameGraph, saveFlow } from '~/lib/flows.server';
import { demoAvailable } from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/flow-action';

/** JSON actions from the flow editor: save, publish, test. */
export async function action({ request, params }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  let body: { intent: string; flow?: unknown };
  try {
    body = JSON.parse(await readText(request));
  } catch (err) {
    if (err instanceof BodyTooLarge) return data({ error: err.message }, { status: 413 });
    return data({ error: 'Body must be JSON' }, { status: 400 });
  }
  try {
    const flow = parseFlow({ ...(body.flow as object), id: params.flowId });
    const published = async () => {
      const res = await publish(flow, actor(me));
      if (res.version)
        await audit(request, 'flow.published', {
          actor: me,
          target: flow.id,
          detail: { name: flow.name, version: res.version, via: 'app' },
        });
      return res;
    };
    if (body.intent === 'save') {
      const res = await saveFlow(flow);
      await audit(request, 'flow.saved', {
        actor: me,
        target: flow.id,
        detail: { name: flow.name, via: 'app' },
      });
      return { saved: true, ...res };
    }
    if (body.intent === 'publish') return await published();
    if (body.intent === 'test') {
      // Test the live version when the graph is unchanged; publish only when there is something new.
      const current = await getFlow(flow.id);
      const unchanged =
        !!current?.publishedVersion &&
        !!current.publishedGraph &&
        sameGraph(flow, current.publishedGraph);
      const res = unchanged
        ? { version: current.publishedVersion, errors: [], warnings: [] }
        : await published();
      if (!res.version) return res;
      // A demo scenario's input when the demo data is loaded; otherwise an empty order.
      const sample = (await demoAvailable())
        ? (SCENARIOS.find((s) => s.flowId === flow.id) ??
          SCENARIOS.find((s) => s.input.model === flow.model))
        : undefined;
      const { orderId } = await engine().startOrder({
        flowId: flow.id,
        version: res.version,
        input: sample?.input ?? { model: flow.model, channel: 'manual' },
        startedBy: me.id,
      });
      await audit(request, 'order.started', {
        actor: me,
        target: orderId,
        detail: { flowId: flow.id, version: res.version, test: true, via: 'app' },
      });
      return { ...res, orderId };
    }
  } catch (err) {
    return data({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return data({ error: 'Unknown intent' }, { status: 400 });
}
