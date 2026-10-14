/**
 * Replenish: created by the Workflow binding's cron schedule. Starts one reorder when any SKU is
 * at or below its reorder point; the reorder flow's forecast node decides quantities.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { lowStock } from './connectors';
import { ensureTemplates } from './flows';
import { startOrderOnce } from './orders';

export const REORDER_FLOW_ID = 'tpl-reorder';

export class Replenish extends WorkflowEntrypoint<Env, { flowId?: string }> {
  override async run(event: Readonly<WorkflowEvent<{ flowId?: string }>>, step: WorkflowStep) {
    const low = await step.do('scan stock', async () =>
      (await lowStock(this.env)).map((p) => p.sku),
    );
    if (!low.length) return { started: null };
    const started = await step.do('start reorder', async () => {
      await ensureTemplates(this.env);
      // Keyed by the instance, so a retry after the order row was written finishes that order.
      const r = await startOrderOnce(this.env, {
        idempotencyKey: `replenish:${event.instanceId}`,
        flowId: event.payload?.flowId ?? REORDER_FLOW_ID,
        input: {
          model: 'replenishment',
          channel: 'schedule',
          title: `Replenish ${low.join(', ')}`,
          currency: 'USD',
          lines: [],
          customerId: 'cus_internal',
          meta: { trigger: event.schedule ? `cron ${event.schedule.cron}` : 'manual', skus: low },
        },
      });
      if ('mismatch' in r)
        throw new Error(`Reorder for ${event.instanceId} changed between retries`);
      return r;
    });
    return { started };
  }
}
