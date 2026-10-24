/**
 * OrderLoop: one generic Workflow that interprets a pinned flow version for one order.
 *
 * Determinism: the planner (`@orderloop/core` graph.ts) is pure, every node's effects come back as
 * a memoized step result, and nodes in a batch are applied in graph order, so a replay after
 * hibernation rebuilds exactly the same plan. Reports to the OrderAgent carry a sequence number;
 * the agent ignores anything not newer than what it has, so replays never move the UI backwards.
 *
 * Steps per node: `${nodeId}#${run}` (run counts make loop iterations distinct). Waiting nodes
 * add `:open` / `:close` steps around `step.waitForEvent`.
 *
 * Effects (connector writes, webhook deliveries, wait event types, timeline entries) are keyed by
 * `effectKey`, which adds the generation after a continue-as-new: run counts restart in every
 * generation, so step names repeat across generations while their effects must not.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  beginNode,
  completeLoop,
  completeNode,
  evaluate,
  type FlowNode,
  type FlowVersion,
  initPlan,
  interpolate,
  NODE_EVENTS,
  type NodeRegistry,
  type Order,
  type OrderStatus,
  type OutboundEvent,
  orderReference,
  type PendingWait,
  type PlanState,
  type PluginManifest,
  pluginOf,
  type RunContext,
  readyNodes,
  staticRegistry,
  truthy,
  withPlugins,
} from '@orderloop/core';
import type { Report } from './agent';
import { loadFlowVersion } from './flows';
import { orderAgent } from './namespaces';
import { EXECUTORS, type NodeResult, ROLLBACKS, scaled } from './nodes';
import { instanceExists } from './orders';
import { emit, orderSummary } from './outbox';
import { execPluginNode, flowManifests, pluginRollback, usesPlugins } from './plugins';

export type OrderLoopParams = {
  orderId: string;
  flowId: string;
  version: number;
  generation: number;
  order: Order;
  vars: Record<string, unknown>;
};

type Outcome =
  | { kind: 'complete'; result: NodeResult }
  | { kind: 'loop'; next: boolean; result: NodeResult }
  | { kind: 'end'; outcome: 'completed' | 'declined' | 'cancelled' | 'failed'; reason: string }
  | { kind: 'continue' };

/** Workflow event types allow only [a-zA-Z0-9_-]. */
const eventTypeFor = (prefix: string, stepKey: string) =>
  `${prefix}-${stepKey}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100);

/** The key a node's effects are idempotent on: its step name, plus the generation after the first. */
export const effectKey = (generation: number, stepKey: string) =>
  generation > 1 ? `${stepKey}@g${generation}` : stepKey;

/** "goods.received" → "goods_received": where an event's payload lands in vars. */
export const eventVar = (event: string) => event.replace(/[^a-zA-Z0-9]+/g, '_');

export class OrderLoop extends WorkflowEntrypoint<Env, OrderLoopParams> {
  override async run(event: Readonly<WorkflowEvent<OrderLoopParams>>, step: WorkflowStep) {
    const p = event.payload;
    const agent = orderAgent(this.env, p.orderId);
    const flow = JSON.parse(
      await step.do('load-flow', async () => {
        const f = await loadFlowVersion(this.env, p.flowId, p.version);
        if (!f) throw new NonRetryableError(`Flow ${p.flowId} v${p.version} not found`);
        return JSON.stringify(f);
      }),
    ) as FlowVersion;
    // A flow with plugin nodes reads the installed plugins' specs once, durably, so a replay sees
    // the same specs even if a plugin is redeployed meanwhile. Other flows add no step.
    const registry: NodeRegistry = usesPlugins(flow)
      ? withPlugins(
          JSON.parse(
            await step.do('load-plugins', async () =>
              JSON.stringify(await flowManifests(this.env, flow)),
            ),
          ) as PluginManifest[],
        )
      : staticRegistry;

    const plan = initPlan(flow);
    const ctx: RunContext = {
      order: p.order,
      nodes: {},
      vars: { ...p.vars },
      input: p.order.meta ?? {},
      now: event.timestamp.getTime(),
      ref: orderReference(p.order),
    };
    let seq = 0;
    const report = async (r: Omit<Report, 'seq' | 'generation'>, durable = false) => {
      // Non-durable reports (plan snapshots) are sequenced; durable ones are already exactly-once.
      const msg: Report = { ...r, generation: p.generation, ...(durable ? {} : { seq: ++seq }) };
      try {
        await agent.report(msg);
      } catch (err) {
        console.warn('report failed', err);
      }
    };
    const snapshot = (status: OrderStatus, extra: Partial<Report> = {}) =>
      report({ status, plan: clonePlan(plan), order: ctx.order, vars: ctx.vars, ...extra });

    await snapshot('running');

    let end: Extract<Outcome, { kind: 'end' }> | null = null;
    while (!end) {
      const { ready } = readyNodes(flow, plan);
      if (!ready.length) break;
      const nodes = ready.map((id) => flow.nodes.find((n) => n.id === id)!);
      const keys = nodes.map((n) => beginNode(plan, n.id));
      for (const n of nodes)
        if (registry.spec(n.type)?.waits || n.type === 'control.wait')
          plan.nodes[n.id]!.status = 'waiting';
      // The batch's snapshot goes out alongside its nodes rather than before them: it is
      // sequenced, so the agent drops it if a newer one lands first, and it never throws.
      const batchSnapshot = snapshot(
        nodes.some((n) => plan.nodes[n.id]!.status === 'waiting') ? 'waiting' : 'running',
      );

      const [, ...outcomes] = await Promise.all([
        batchSnapshot,
        ...nodes.map((n, i) => this.runNode(step, plan, ctx, n, keys[i]!, p, report, registry)),
      ]);

      // Apply in graph order so the plan is identical on replay.
      let continueKey: string | null = null;
      for (const [i, out] of outcomes.entries()) {
        const n = nodes[i]!;
        if (out.kind === 'end') {
          completeNode(flow, plan, n.id, []);
          end = out;
          continue;
        }
        if (out.kind === 'continue') {
          completeNode(flow, plan, n.id, []);
          continueKey = keys[i]!;
          continue;
        }
        applyResult(ctx, n.id, out.result);
        if (out.kind === 'loop') completeLoop(flow, plan, n.id, out.next);
        else completeNode(flow, plan, n.id, out.result.branches ?? ['out']);
      }
      // Continue only once the whole batch is applied, so its siblings' outputs carry over.
      if (continueKey && !end) {
        await this.continueAsNew(step, p, ctx, continueKey);
        await snapshot('running');
        return { continuedAs: p.generation + 1 };
      }
      await snapshot('running');
    }

    const outcome = end?.outcome ?? 'completed';
    const reason = end?.reason ?? '';
    await snapshot(outcome, { reason });
    if (outcome === 'failed') {
      // Fails the instance; Workflows then runs every registered rollback in reverse order.
      throw new NonRetryableError(reason || 'Order failed');
    }
    return { outcome, total: ctx.order.total };
  }

  /** Starts the next generation. Retry-safe: a retry after `create` succeeded finds the instance. */
  private async continueAsNew(
    step: WorkflowStep,
    p: OrderLoopParams,
    ctx: RunContext,
    key: string,
  ) {
    const env = this.env;
    await step.do(key, async () => {
      const generation = p.generation + 1;
      const id = `${p.orderId}-g${generation}`;
      // An order started before documents moved to R2 may still carry the text; drop it once stored.
      const { documentText: _text, ...stored } = ctx.order;
      const order = stored.documentKey ? stored : ctx.order;
      const params: OrderLoopParams = { ...p, generation, order, vars: ctx.vars };
      try {
        await env.ORDER_LOOP.create({ id, params });
      } catch (err) {
        if (!(await instanceExists(env, id))) throw err;
      }
      await orderAgent(env, p.orderId).continuedAs(id, generation);
      return id;
    });
  }

  private async runNode(
    step: WorkflowStep,
    plan: PlanState,
    ctx: RunContext,
    node: FlowNode,
    key: string,
    p: OrderLoopParams,
    report: (r: Omit<Report, 'seq' | 'generation'>, durable?: boolean) => Promise<void>,
    registry: NodeRegistry,
  ): Promise<Outcome> {
    const env = this.env;
    const agent = orderAgent(env, p.orderId);
    const spec = registry.spec(node.type);
    const config = registry.withDefaults(node.type, node.config);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const fx = effectKey(p.generation, key);

    switch (node.type) {
      case 'control.approval':
      case 'control.wait_event': {
        const approval = node.type === 'control.approval';
        const eventType = eventTypeFor(approval ? 'approval' : 'event', fx);
        const timeout = str(config.timeout) || '7 days';
        const wait: PendingWait = {
          nodeId: node.id,
          eventType,
          kind: approval ? 'approval' : 'event',
          title: approval
            ? interpolate(str(config.title), ctx)
            : `Waiting for ${str(config.event)}`,
          event: approval ? undefined : str(config.event),
          assignee: approval ? str(config.assignee) : undefined,
          amount: ctx.order.total,
          deadline: ctx.now + scaled(env, timeout),
          since: Date.now(),
        };
        await step.do(`${key}:open`, async () => {
          await agent.openWait({
            ...wait,
            since: Date.now(),
            deadline: Date.now() + scaled(env, timeout),
          });
          return true;
        });
        let branch: string;
        let payload: Record<string, unknown> = {};
        try {
          const ev = await step.waitForEvent<Record<string, string | number | boolean | null>>(
            key,
            {
              type: eventType,
              timeout: scaled(env, timeout),
            },
          );
          payload = (ev.payload ?? {}) as Record<string, unknown>;
          branch = approval
            ? payload.decision === 'approved'
              ? 'approved'
              : 'rejected'
            : 'received';
        } catch {
          branch = approval ? 'escalated' : 'timeout';
        }
        await step.do(`${key}:close`, async () => {
          await agent.closeWait(eventType, branch, payload);
          return true;
        });
        const result: NodeResult = {
          branches: [branch],
          output: { ...payload, outcome: branch },
          summary: approval
            ? branch === 'escalated'
              ? 'Timed out'
              : `${branch}${payload.by ? ` by ${String(payload.by)}` : ''}`
            : branch === 'received'
              ? `${str(config.event)} received`
              : 'Timed out',
          vars: approval ? undefined : { [eventVar(str(config.event))]: payload },
        };
        await report(
          {
            node: {
              id: node.id,
              summary: result.summary,
              output: result.output,
              endedAt: Date.now(),
            },
          },
          true,
        );
        return { kind: 'complete', result };
      }

      case 'control.wait': {
        const until = config.until
          ? await step.do(`${key}:until`, async () => Number(evaluate(config.until, ctx)) || 0)
          : 0;
        if (until > 0) await step.sleepUntil(key, until);
        else await step.sleep(key, scaled(env, str(config.duration) || '1 day'));
        const result: NodeResult = {
          summary: until
            ? `Until ${new Date(until).toISOString()}`
            : `Waited ${str(config.duration)}`,
        };
        await report({ node: { id: node.id, summary: result.summary, endedAt: Date.now() } }, true);
        return { kind: 'complete', result };
      }

      case 'control.loop': {
        const runs = plan.nodes[node.id]!.runs;
        const max = Number(config.maxIterations ?? 12);
        const next = await step.do(
          key,
          async () => runs <= max && truthy(config.while ?? true, ctx),
        );
        const result: NodeResult = {
          output: { iteration: runs, next },
          summary: next ? `Iteration ${runs}` : `Done after ${runs - 1}`,
        };
        await report(
          { node: { id: node.id, summary: result.summary, output: result.output } },
          true,
        );
        return { kind: 'loop', next, result };
      }

      case 'control.end': {
        const outcome = (str(config.outcome) || 'completed') as
          | 'completed'
          | 'declined'
          | 'cancelled'
          | 'failed';
        const reason = interpolate(str(config.reason), ctx);
        await report(
          { node: { id: node.id, summary: reason || outcome, endedAt: Date.now() } },
          true,
        );
        await emitStep(step, env, key, fx, p.orderId, `order.${outcome}`, {
          order: orderSummary(ctx.order),
          outcome,
          reason,
        });
        return { kind: 'end', outcome, reason };
      }

      case 'control.continue_as_new':
        // Started by `continueAsNew` after the batch is applied.
        return { kind: 'continue' };
    }

    const fromPlugin = pluginOf(node.type) !== null;
    const exec = EXECUTORS[node.type] ?? (fromPlugin ? execPluginNode : undefined);
    if (!exec) throw new NonRetryableError(`No executor for ${node.type}`);
    const rollback = !spec?.rollback
      ? undefined
      : fromPlugin
        ? pluginRollback(node.type, node.id, fx)
        : ROLLBACKS[node.type];
    const retries = node.retries ?? spec?.retries ?? 3;
    try {
      const result = (await step.do(
        key,
        {
          retries: { limit: retries, delay: '5 seconds', backoff: 'exponential' },
          timeout: (node.timeout as `${number} seconds`) ?? '5 minutes',
        },
        async (sctx) => {
          await report(
            {
              node: { id: node.id, startedAt: Date.now() },
              log:
                sctx.attempt > 1
                  ? {
                      at: Date.now(),
                      nodeId: node.id,
                      kind: 'node',
                      message: `${node.label}: attempt ${sctx.attempt}`,
                      key: `${fx}:a${sctx.attempt}`,
                    }
                  : undefined,
            },
            true,
          );
          const r = await exec({ env, node, config, ctx, stepKey: fx, registry });
          await report(
            {
              node: {
                id: node.id,
                summary: r.summary,
                output: r.output,
                endedAt: Date.now(),
                error: undefined,
              },
              log: {
                at: Date.now(),
                nodeId: node.id,
                kind: node.type.startsWith('ai.') ? 'ai' : 'node',
                message: `${node.label}: ${r.summary ?? 'done'}`,
                key: fx,
              },
            },
            true,
          );
          return JSON.parse(JSON.stringify(r)) as NodeResult & Rpc.Serializable<NodeResult>;
        },
        rollback
          ? {
              rollback: async ({ output, error }) => {
                const message = await rollback(
                  env,
                  p.orderId,
                  (output as NodeResult | undefined)?.output,
                );
                // The compensation already ran: a failed report must not make Workflows retry it.
                try {
                  await agent.report({
                    generation: p.generation,
                    node: { id: node.id, status: 'rolled_back', summary: message },
                    log: {
                      at: Date.now(),
                      nodeId: node.id,
                      kind: 'rollback',
                      message: `${node.label}: ${message} (${error.message})`,
                      key: `${fx}:rollback`,
                    },
                  });
                } catch (err) {
                  console.warn('rollback report failed', err);
                }
              },
              rollbackConfig: {
                retries: { limit: 3, delay: '10 seconds', backoff: 'linear' },
                timeout: '2 minutes',
              },
            }
          : undefined,
      )) as NodeResult;
      const emits = NODE_EVENTS[node.type];
      if (emits && (!emits.branch || (result.branches ?? ['out']).includes(emits.branch))) {
        await emitStep(step, env, key, fx, p.orderId, emits.event, {
          order: orderSummary({ ...ctx.order, ...result.order }),
          node: { id: node.id, type: node.type, output: result.output ?? null },
        });
      }
      return { kind: 'complete', result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await report(
        {
          node: { id: node.id, status: 'failed', error: message, endedAt: Date.now() },
          log: {
            at: Date.now(),
            nodeId: node.id,
            kind: 'node',
            message: `${node.label} failed: ${message}`,
            key: `${fx}:failed`,
          },
        },
        true,
      );
      const reason = `${node.label}: ${message}`;
      await report({ status: 'failed', reason });
      // A thrown node fails the instance without reaching an End node, so announce it here.
      await emitStep(step, env, key, fx, p.orderId, 'order.failed', {
        order: orderSummary(ctx.order),
        outcome: 'failed',
        reason,
        node: { id: node.id, type: node.type, error: message },
      });
      throw err;
    }
  }
}

/**
 * Delivers an outbound webhook in its own step (`${key}:emit`), keyed by the node's effect key
 * `fx`. The step throws while deliveries
 * are pending so Workflows retries it with backoff; once retries run out the error is swallowed,
 * because a subscriber being down must never fail the order. Undelivered rows stay `failed`.
 */
async function emitStep(
  step: WorkflowStep,
  env: Env,
  key: string,
  fx: string,
  orderId: string,
  event: OutboundEvent,
  data: Record<string, unknown>,
) {
  try {
    await step.do(
      `${key}:emit`,
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
      async () => {
        const r = await emit(env, fx, orderId, event, data);
        if (r.pending) throw new Error(`${r.pending} ${event} deliveries pending`);
        return r;
      },
    );
  } catch (err) {
    console.warn('webhook delivery gave up', event, err);
  }
}

function applyResult(ctx: RunContext, nodeId: string, r: NodeResult) {
  ctx.nodes[nodeId] = r.output ?? null;
  if (r.order) ctx.order = { ...ctx.order, ...r.order };
  if (r.vars) ctx.vars = { ...ctx.vars, ...r.vars };
  if (r.pluginVars) {
    const plugins = (ctx.vars.plugins ?? {}) as Record<string, Record<string, unknown>>;
    const { id, vars } = r.pluginVars;
    ctx.vars = { ...ctx.vars, plugins: { ...plugins, [id]: { ...plugins[id], ...vars } } };
  }
}

function clonePlan(plan: PlanState): PlanState {
  return { nodes: structuredClone(plan.nodes), edges: { ...plan.edges } };
}
