import { data } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import { BodyTooLarge, readText } from '~/lib/body';
import { engine } from '~/lib/env.server';
import { getFlow, parseFlow, publish, sameGraph, saveFlow } from '~/lib/flows.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/flow-action';

/** JSON actions from the flow editor: save, publish, test. */
export async function action({ request, params }: Route.ActionArgs) {
  await requireUser(request, 'operator');
  let body: { intent: string; flow?: unknown };
  try {
    body = JSON.parse(await readText(request));
  } catch (err) {
    if (err instanceof BodyTooLarge) return data({ error: err.message }, { status: 413 });
    return data({ error: 'Body must be JSON' }, { status: 400 });
  }
  try {
    const flow = parseFlow({ ...(body.flow as object), id: params.flowId });
    if (body.intent === 'save') return { saved: true, ...(await saveFlow(flow)) };
    if (body.intent === 'publish') return await publish(flow);
    if (body.intent === 'test') {
      // Test the live version when the graph is unchanged; publish only when there is something new.
      const current = await getFlow(flow.id);
      const unchanged =
        !!current?.publishedVersion &&
        !!current.publishedGraph &&
        sameGraph(flow, current.publishedGraph);
      const res = unchanged
        ? { version: current.publishedVersion, errors: [], warnings: [] }
        : await publish(flow);
      if (!res.version) return res;
      const sample =
        SCENARIOS.find((s) => s.flowId === flow.id) ??
        SCENARIOS.find((s) => s.input.model === flow.model);
      const { orderId } = await engine().startOrder({
        flowId: flow.id,
        version: res.version,
        input: sample?.input ?? { model: flow.model, channel: 'manual' },
      });
      return { ...res, orderId };
    }
  } catch (err) {
    return data({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return data({ error: 'Unknown intent' }, { status: 400 });
}
