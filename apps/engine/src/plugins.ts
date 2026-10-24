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
  type FlowGraph,
  missing,
  type NodeRegistry,
  type OutboundPayload,
  type PluginManifest,
  type PluginRpc,
  type PluginUsage,
  parseManifest,
  pluginBinding,
  pluginOf,
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
let cached: { at: number; key: string; manifests: PluginManifest[] } | null = null;

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

/**
 * The installed plugins' manifests. A plugin whose manifest doesn't parse, whose id doesn't match
 * its binding, or that misses a plugin it requires is left out (and logged): its nodes then read
 * as not installed, while every other flow keeps running.
 */
export async function manifests(env: Env): Promise<PluginManifest[]> {
  const bound = pluginBindings(env);
  if (!bound.length) return [];
  const key = bound.map(([k]) => k).join(',');
  if (cached && cached.key === key && Date.now() - cached.at < MANIFEST_TTL_MS)
    return cached.manifests;
  const got = await Promise.all(
    bound.map(async ([name, stub]) => {
      try {
        const m = parseManifest(await stub.manifest());
        if (pluginBinding(m.id) !== name) throw new Error(`id “${m.id}” is not bound as ${name}`);
        return m;
      } catch (err) {
        console.error('plugin manifest refused', name, err);
        return null;
      }
    }),
  );
  const ok = got.filter((m) => m !== null);
  const ids = new Set(ok.map((m) => m.id));
  const usable = ok.filter((m) => {
    const absent = m.requires.filter((r) => !ids.has(r));
    if (absent.length) console.error('plugin missing requirements', m.id, absent);
    return !absent.length;
  });
  cached = { at: Date.now(), key, manifests: usable };
  return usable;
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
  const spec = (await registry(env)).spec(node.type);
  if (!stub || !spec) throw new NonRetryableError(missing(node.type));
  const r = await stub.execute({
    type: node.type,
    nodeId: node.id,
    stepKey,
    orderId: ctx.order.id,
    config,
    order: ctx.order,
    vars: ctx.vars,
    nodes: ctx.nodes,
  });
  const outputs = spec.outputs as string[];
  const branch = r.branch ?? outputs[0]!;
  if (!outputs.includes(branch))
    throw new NonRetryableError(`${node.type} chose “${branch}”, which isn't one of its outputs`);
  return { branches: [branch], output: r.output, summary: r.summary, vars: r.vars };
}

/** The compensation for a plugin node with `rollback`; it throws if the plugin is gone. */
export function pluginRollback(type: string, nodeId: string, stepKey: string) {
  return async (env: Env, orderId: string, output: unknown) => {
    const id = pluginOf(type);
    const stub = id ? plugin(env, id) : null;
    if (!stub) throw new Error(`${missing(type)}, so ${type} could not be undone`);
    return stub.compensate({ type, nodeId, stepKey, orderId, output });
  };
}

/** Delivers an outbound event over a plugin's binding. Never throws; the outbox retries. */
export async function deliverToPlugin(env: Env, id: string, payload: OutboundPayload) {
  const stub = plugin(env, id);
  if (!stub) return { ok: false, status: null, error: missing(`${id}.*`) };
  try {
    await stub.deliver(payload);
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
