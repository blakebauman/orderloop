/**
 * Installed plugins: each is a service binding named `PLUGIN_<ID>`, which scripts/fleet.ts renders
 * from the deployment's `plugins` list. The contract is `PluginRpc` in @orderloop/core; see
 * docs/plugins.md. With no bindings, everything here is a no-op and the engine runs the built-in
 * catalog alone.
 *
 * A plugin node runs inside its node's own `step.do`, like any executor, so step names, retries and
 * replays are unchanged. The plugin keys its writes and compensations by the order id and step key
 * it is sent.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  checkExecResult,
  type FlowGraph,
  missing,
  type NodeRegistry,
  type OutboundPayload,
  PLUGIN_SUMMARY_MAX,
  type PluginManifest,
  type PluginOutcome,
  type PluginRpc,
  type PluginStatus,
  type PluginUsage,
  parseManifest,
  pluginBinding,
  pluginOf,
  pluginOrder,
  pluginView,
  staticRegistry,
  TERMINAL_ORDER_STATUSES,
  withPlugins,
} from '@orderloop/core';
import { createDb, flows, flowVersions, orders } from '@orderloop/db';
import { and, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import type { ExecInput, NodeResult } from './nodes';

type PluginStub = Fetcher & { [K in keyof PluginRpc]: PluginRpc[K] };

/** How long an isolate trusts the manifests it fetched; a redeployed plugin shows up after this. */
const MANIFEST_TTL_MS = 60_000;
/** How long one call into a plugin may take, well inside its node's step timeout. */
export const PLUGIN_CALL_MS = 60_000;

let cached: { at: number; key: string; statuses: PluginStatus[] } | null = null;
/**
 * The last manifest each binding answered with, kept while it can't answer (mid-deploy, a blip), so
 * its nodes don't read as not installed and fail running orders.
 */
const lastGood = new Map<string, PluginManifest>();

/** Every `PLUGIN_*` service binding, by binding name. */
export function pluginBindings(env: Env): [string, PluginStub][] {
  return Object.entries(env as unknown as Record<string, unknown>)
    .filter(([k, v]) => k.startsWith('PLUGIN_') && typeof (v as Fetcher)?.fetch === 'function')
    .map(([k, v]) => [k, v as PluginStub]);
}

/** The plugin's binding, or null when it isn't installed. */
export function plugin(env: Env, id: string): PluginStub | null {
  return ((env as unknown as Record<string, unknown>)[pluginBinding(id)] as PluginStub) ?? null;
}

/** Rejects once `ms` pass, so a hung plugin fails its call instead of the whole step. */
export function withTimeout<T>(p: Promise<T>, what: string, ms = PLUGIN_CALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Every plugin binding and what the deployment runs of it (`PluginStatus`). A plugin whose
 * manifest doesn't parse or whose id doesn't match its binding keeps its last good manifest, or is
 * left out when it never had one; one missing a plugin it requires is left out. Either way it is
 * logged and reported unhealthy, its nodes read as not installed, and every other flow keeps
 * running. `fresh` skips the isolate's cache (deep health).
 */
export async function pluginStatuses(env: Env, fresh = false): Promise<PluginStatus[]> {
  const bound = pluginBindings(env);
  if (!bound.length) return [];
  const key = bound.map(([k]) => k).join(',');
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < MANIFEST_TTL_MS)
    return cached.statuses;
  const got = await Promise.all(
    bound.map(async ([binding, stub]): Promise<PluginStatus> => {
      try {
        const m = parseManifest(
          await withTimeout(stub.manifest(), `${binding}.manifest()`, 10_000),
        );
        if (pluginBinding(m.id) !== binding)
          throw new Error(`id “${m.id}” is not bound as ${binding}`);
        lastGood.set(binding, m);
        return { binding, manifest: m, healthy: true };
      } catch (err) {
        console.error('plugin manifest refused', binding, err);
        return {
          binding,
          manifest: lastGood.get(binding) ?? null,
          healthy: false,
          error: message(err),
        };
      }
    }),
  );
  const ids = new Set(got.flatMap((s) => (s.manifest ? [s.manifest.id] : [])));
  const statuses = got.map((s): PluginStatus => {
    const absent = s.manifest?.requires.filter((r) => !ids.has(r)) ?? [];
    if (!absent.length) return s;
    console.error('plugin missing requirements', s.binding, absent);
    return { ...s, manifest: null, healthy: false, error: `Needs ${absent.join(', ')} installed` };
  });
  cached = { at: Date.now(), key, statuses };
  return statuses;
}

/** The manifests of the plugins this deployment runs. */
export async function manifests(env: Env): Promise<PluginManifest[]> {
  return (await pluginStatuses(env)).flatMap((s) => (s.manifest ? [s.manifest] : []));
}

/** Node lookups for this deployment: the built-in catalog plus its plugins' nodes. */
export async function registry(env: Env): Promise<NodeRegistry> {
  const ms = await manifests(env);
  return ms.length ? withPlugins(ms) : staticRegistry;
}

/** True when a graph uses any plugin's nodes (only then does a run need the manifests). */
export const usesPlugins = (graph: Pick<FlowGraph, 'nodes'>) =>
  graph.nodes.some((n) => pluginOf(n.type) !== null);

/** Runs a plugin node. Called inside the node's step; a missing plugin fails it without retries. */
export async function execPluginNode({
  env,
  node,
  config,
  ctx,
  stepKey,
}: ExecInput): Promise<NodeResult> {
  const id = pluginOf(node.type);
  const stub = id ? plugin(env, id) : null;
  const installed = await manifests(env);
  const manifest = installed.find((m) => m.id === id);
  const spec = withPlugins(installed).spec(node.type);
  if (!id || !stub || !manifest || !spec) throw new NonRetryableError(missing(node.type));
  const result = await withTimeout(
    stub.execute({
      type: node.type,
      nodeId: node.id,
      stepKey,
      orderId: ctx.order.id,
      config,
      order: pluginOrder(manifest, ctx.order),
      vars: pluginView(manifest, ctx.vars),
      nodes: pluginView(manifest, ctx.nodes),
    }),
    `${node.type} (execute)`,
  );
  let outcome: PluginOutcome;
  try {
    outcome = checkExecResult(node.type, result, spec.outputs as string[]);
  } catch (err) {
    // The same plugin code would return the same thing again: no retry.
    throw new NonRetryableError(message(err));
  }
  if (outcome.kind === 'fail') {
    if (outcome.retry) throw new Error(outcome.message);
    throw new NonRetryableError(outcome.message);
  }
  // A plugin's variables live under its id, so it can't overwrite the flow's or another plugin's.
  const own = (ctx.vars[id] ?? {}) as Record<string, unknown>;
  return {
    branches: [outcome.branch],
    output: outcome.output,
    summary: outcome.summary,
    ...(outcome.vars ? { vars: { [id]: { ...own, ...outcome.vars } } } : {}),
  };
}

/** The compensation for a plugin node with `rollback`; it throws if the plugin is gone. */
export function pluginRollback(type: string, nodeId: string, stepKey: string) {
  return async (env: Env, orderId: string, output: unknown) => {
    const id = pluginOf(type);
    const stub = id ? plugin(env, id) : null;
    if (!stub) throw new Error(`${missing(type)}, so ${type} could not be undone`);
    const said = await withTimeout(
      stub.compensate({ type, nodeId, stepKey, orderId, output }),
      `${type} (compensate)`,
    );
    return typeof said === 'string' ? said.slice(0, PLUGIN_SUMMARY_MAX) : 'Undone';
  };
}

/** Delivers an outbound event over a plugin's binding. Never throws; the outbox retries. */
export async function deliverToPlugin(env: Env, id: string, payload: OutboundPayload) {
  const stub = plugin(env, id);
  if (!stub) return { ok: false, status: null, error: missing(`${id}.*`) };
  try {
    await withTimeout(stub.deliver(payload), `${id}.deliver()`, 30_000);
    return { ok: true, status: 200, error: null };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What still depends on a plugin, so it isn't removed from under a flow or a running order. */
export async function pluginUsage(env: Env, id: string): Promise<PluginUsage> {
  const d = createDb(env.DB);
  const usesIt = (json: string) =>
    (JSON.parse(json) as FlowGraph).nodes.some((n) => pluginOf(n.type) === id);
  const published = await d
    .select({ id: flows.id, version: flowVersions.version, json: flowVersions.flowJson })
    .from(flows)
    .innerJoin(
      flowVersions,
      and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.publishedVersion)),
    )
    .where(and(isNotNull(flows.publishedVersion), isNull(flows.archivedAt)));
  const running = await d
    .select({
      id: orders.id,
      flowId: orders.flowId,
      version: orders.flowVersion,
      json: flowVersions.flowJson,
    })
    .from(orders)
    .innerJoin(
      flowVersions,
      and(eq(flowVersions.flowId, orders.flowId), eq(flowVersions.version, orders.flowVersion)),
    )
    .where(notInArray(orders.status, TERMINAL_ORDER_STATUSES));
  return {
    flows: published.filter((f) => usesIt(f.json)).map(({ id, version }) => ({ id, version })),
    orders: running
      .filter((o) => usesIt(o.json))
      .map(({ id, flowId, version }) => ({ id, flowId, version })),
  };
}
