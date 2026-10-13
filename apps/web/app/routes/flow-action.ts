import { type Flow, flowGraphSchema } from '@orderloop/core';
import { data } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { parseFlow, publish, saveFlow } from '~/lib/flows.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/flow-action';

/** JSON actions from the flow editor: save, publish, copilot, test. */
export async function action({ request, params }: Route.ActionArgs) {
  await requireUser(request);
  const body = (await request.json()) as { intent: string; flow?: unknown; prompt?: string };
  try {
    if (body.intent === 'copilot') {
      const graph = flowGraphSchema.parse(
        (body.flow as Flow | undefined) ?? { nodes: [], edges: [] },
      );
      const orderType = (body.flow as Flow | undefined)?.orderType;
      return await engine().copilot({ prompt: String(body.prompt ?? ''), graph, orderType });
    }
    const flow = parseFlow({ ...(body.flow as object), id: params.flowId });
    if (body.intent === 'save') return { saved: true, ...(await saveFlow(flow)) };
    if (body.intent === 'publish') return await publish(flow);
    if (body.intent === 'test') {
      const res = await publish(flow);
      if (!res.version) return res;
      const sample = SCENARIOS.find((s) => s.input.type === flow.orderType);
      const { orderId } = await engine().startOrder({
        flowId: flow.id,
        version: res.version,
        input: sample?.input ?? { type: flow.orderType, currency: 'USD', lines: [], meta: {} },
      });
      return { ...res, orderId };
    }
  } catch (err) {
    return data({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return data({ error: 'Unknown intent' }, { status: 400 });
}
