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
  flowPlugins,
  missing,
  type NodeRegistry,
  type OutboundPayload,
  PLUGIN_SUMMARY_MAX,
  type PluginManifest,
  type PluginOutcome,
  type PluginStatus,
  type PluginUsage,
  parseManifest,
  pluginOf,
  pluginOrder,
  pluginView,
  scrubCredentials,
  staticRegistry,
  TERMINAL_ORDER_STATUSES,
  withPlugins,
} from '@orderloop/core';
import { createDb, flows, flowVersions, orders, shipments } from '@orderloop/db';
import { and, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import type { ExecInput, NodeResult } from './nodes';
import {
  activeInstalls,
  type CallKind,
  installedPlugins,
  knownManifests,
  knownSecretValues,
  type PluginStub,
  pinnedManifest,
  pluginStub,
  registryOwns,
} from './plugin-host';

/** How long an isolate trusts the manifests it fetched; a redeployed plugin shows up after this. */
const MANIFEST_TTL_MS = 60_000;
/** How long one call into a plugin may take, well inside its node's step timeout. */
export const PLUGIN_CALL_MS = 60_000;

/** How soon a plugin that didn't answer is asked again. */
const UNHEALTHY_TTL_MS = 5_000;
/** The least time between uncached reads (deep health). */
const FRESH_MIN_MS = 10_000;

type Cached = { at: number; key: string; ttl: number; statuses: PluginStatus[] };
/** Per environment (one per isolate in production), so a different `env` never reads another's. */
const caches = new WeakMap<object, Cached>();

/**
 * What the deployment grants each plugin beyond the defaults: from its registry entry
 * (`PLUGIN_GRANTS`, rendered by scripts/fleet.ts: `{ "<id>": { "personalData": "send" } }`), or
 * for a runtime install, what the admin approved. A manifest can't grant itself buyer details.
 */
async function grants(env: Env): Promise<Record<string, { personalData?: 'send' }>> {
  const raw = (env as unknown as { PLUGIN_GRANTS?: string }).PLUGIN_GRANTS;
  let out: Record<string, { personalData?: 'send' }> = {};
  try {
    out = raw ? (JSON.parse(raw) as Record<string, { personalData?: 'send' }>) : {};
  } catch {
    console.error('PLUGIN_GRANTS is not JSON; granting nothing');
  }
  // A runtime install's grant is its own: never one for a registry plugin of the same id.
  for (const [id, a] of await activeInstalls(env))
    if (a.personalData && !registryOwns(env, id)) out[id] = { personalData: 'send' };
  return out;
}
/**
 * The last manifest each plugin answered with (`knownManifests`), kept while it can't answer
 * (mid-deploy, a blip), so its nodes don't read as not installed and fail running orders.
 */
const lastGood = knownManifests;

/**
 * The plugin to call (its binding, or its sandbox with the limits for `kind`), or null when it
 * isn't installed. See plugin-host.ts.
 */
export function plugin(env: Env, id: string, kind: CallKind = 'call'): Promise<PluginStub | null> {
  return pluginStub(env, id, kind);
}

/** Whether this deployment installs any plugin (a binding, a pinned bundle or a runtime install). */
export const hasPlugins = async (env: Env) => (await installedPlugins(env)).length > 0;

/** `text` without the plugin's secrets, or anything shaped like a credential. */
export async function scrubbed(env: Env, id: string, text: string) {
  return scrubCredentials(text, await knownSecretValues(env, id));
}

/**
 * `value` (a node's output or variables, a provider's answer) with the plugin's own secret values
 * replaced wherever they appear: an upstream that echoes a request must not land one in an order.
 * Only exact values: anything else in a plugin's data is left as it is.
 */
export async function scrubbedValue<T>(env: Env, id: string, value: T): Promise<T> {
  if (value === undefined) return value;
  const known = (await knownSecretValues(env, id)).filter((k) => k.length >= 4);
  if (!known.length) return value;
  let text = JSON.stringify(value);
  for (const k of known.sort((a, b) => b.length - a.length))
    text = text.split(JSON.stringify(k).slice(1, -1)).join('[redacted]');
  return JSON.parse(text) as T;
}

/**
 * A call into plugin `id`, held to `ms`: what it throws comes back scrubbed of its secrets (a
 * plugin's error text reaches the order's timeline), as a `NonRetryableError` if it was one.
 */
export async function callPlugin<T>(
  env: Env,
  id: string,
  p: Promise<T>,
  what: string,
  ms = PLUGIN_CALL_MS,
): Promise<T> {
  try {
    return await withTimeout(p, what, ms);
  } catch (err) {
    const text = await scrubbed(env, id, message(err));
    throw err instanceof NonRetryableError ? new NonRetryableError(text) : new Error(text);
  }
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
  const installed = await installedPlugins(env);
  const granted = await grants(env);
  if (!installed.length) return [];
  // The pin is part of the key, so a new version (an upgrade, a rollback) is read at once.
  const key = installed.map((p) => `${p.id}:${p.runtime}:${p.source}:${p.sha ?? ''}`).join(',');
  // Deep health asks for fresh statuses, but at most every few seconds: it is a public route.
  const cached = caches.get(env);
  const age = cached && cached.key === key ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
  if (cached && age < (fresh ? FRESH_MIN_MS : cached.ttl)) return cached.statuses;
  const check = async ({
    id,
    runtime,
    source,
  }: (typeof installed)[number]): Promise<PluginStatus> => {
    try {
      const stub = await pluginStub(env, id, 'serve');
      if (!stub) throw new Error('not installed');
      const m = parseManifest(
        await callPlugin(env, id, stub.manifest(), `${id}.manifest()`, 10_000),
      );
      if (m.id !== id) throw new Error(`id “${m.id}” is installed as “${id}”`);
      // A sandboxed plugin runs by the manifest CI pinned with its bundle; one whose code now
      // answers otherwise (more egress, a secret it may read) is refused, not believed.
      const pinned = runtime === 'sandboxed' ? await pinnedManifest(env, id) : null;
      if (pinned && JSON.stringify(pinned) !== JSON.stringify(m))
        throw new Error('Its manifest differs from the one pinned with its bundle');
      if (m.personalData === 'send' && granted[m.id]?.personalData !== 'send')
        throw new Error(
          'It asks for buyer details (personalData: "send"), which this deployment does not grant',
        );
      lastGood.set(id, m);
      return { id, runtime, source, manifest: m, healthy: true };
    } catch (err) {
      console.error('plugin manifest refused', id, err);
      // The last good manifest stands in, but never past a grant the deployment has withdrawn.
      const fallback = lastGood.get(id);
      const allowed =
        fallback &&
        (fallback.personalData !== 'send' || granted[fallback.id]?.personalData === 'send');
      return {
        id,
        runtime,
        source,
        manifest: allowed ? fallback : null,
        healthy: false,
        error: message(err),
      };
    }
  };
  // Worker plugins at once; sandboxed ones one at a time (Worker Loader limits how many Dynamic
  // Workers a request has in flight).
  const workers = Promise.all(installed.filter((p) => p.runtime === 'worker').map(check));
  const inTurn: PluginStatus[] = [];
  for (const p of installed.filter((x) => x.runtime === 'sandboxed')) inTurn.push(await check(p));
  const byId = new Map([...(await workers), ...inTurn].map((x) => [x.id, x]));
  const got = installed.map((p) => byId.get(p.id)!);
  const ids = new Set(got.flatMap((s) => (s.manifest ? [s.manifest.id] : [])));
  const statuses = got.map((s): PluginStatus => {
    const absent = s.manifest?.requires.filter((r) => !ids.has(r)) ?? [];
    if (!absent.length) return s;
    console.error('plugin missing requirements', s.id, absent);
    return { ...s, manifest: null, healthy: false, error: `Needs ${absent.join(', ')} installed` };
  });
  // A plugin that didn't answer is asked again soon, not after the full minute.
  const ttl = statuses.every((s) => s.healthy) ? MANIFEST_TTL_MS : UNHEALTHY_TTL_MS;
  caches.set(env, { at: Date.now(), key, ttl, statuses });
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

/**
 * The manifests a run of `flow` is planned with (its `load-plugins` step). Throws, so the step is
 * retried, while a plugin the flow uses is bound but hasn't answered: recording it as not installed
 * would fail the order for good and run its nodes without their rollbacks. A plugin that isn't
 * bound at all is left out; its nodes then fail as not installed.
 */
export async function flowManifests(env: Env, flow: Pick<FlowGraph, 'nodes'>) {
  const statuses = await pluginStatuses(env);
  const used = flowPlugins(flow);
  for (const id of used) {
    const s = statuses.find((x) => x.id === id);
    if (s && !s.manifest) throw new Error(`Plugin “${id}” is not answering: ${s.error}`);
  }
  return statuses.flatMap((s) => (s.manifest ? [s.manifest] : []));
}

/**
 * True when a graph uses any plugin, for its nodes or as a provider (only then does a run need
 * the manifests).
 */
export const usesPlugins = (graph: Pick<FlowGraph, 'nodes'>) => flowPlugins(graph).size > 0;

/**
 * Runs a plugin node, inside the node's step. Its branch is checked against the node as the run
 * was planned (`registry`, the `load-plugins` snapshot), so a plugin redeployed mid-order can't
 * steer the order down an edge its flow doesn't have. A plugin that isn't bound fails the node for
 * good; one that is bound but not answering fails this attempt, to be retried.
 */
export async function execPluginNode({
  env,
  node,
  config,
  ctx,
  stepKey,
  registry: planned,
}: ExecInput): Promise<NodeResult> {
  const id = pluginOf(node.type);
  const stub = id ? await plugin(env, id) : null;
  if (!id || !stub) throw new NonRetryableError(missing(node.type));
  const installed = await manifests(env);
  const manifest = installed.find((m) => m.id === id);
  if (!manifest) throw new Error(`Plugin “${id}” is not answering`);
  const spec = (planned ?? withPlugins(installed)).spec(node.type);
  if (!spec) throw new NonRetryableError(missing(node.type));
  const result = await callPlugin(
    env,
    id,
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
    // What a plugin writes back reaches the timeline: never one of its secrets.
    const failed = await scrubbed(env, id, outcome.message);
    if (outcome.retry) throw new Error(failed);
    throw new NonRetryableError(failed);
  }
  // A plugin's variables go to `vars.plugins.<id>`, merged there when the result is applied, so
  // it can't overwrite the flow's own variables or another plugin's.
  return {
    branches: [outcome.branch],
    output: await scrubbedValue(env, id, outcome.output),
    summary: outcome.summary === undefined ? undefined : await scrubbed(env, id, outcome.summary),
    ...(outcome.vars
      ? { pluginVars: { id, vars: await scrubbedValue(env, id, outcome.vars) } }
      : {}),
  };
}

/** The compensation for a plugin node with `rollback`; it throws if the plugin is gone. */
export function pluginRollback(type: string, nodeId: string, stepKey: string) {
  return async (env: Env, orderId: string, output: unknown) => {
    const id = pluginOf(type);
    const stub = id ? await plugin(env, id) : null;
    if (!stub) throw new Error(`${missing(type)}, so ${type} could not be undone`);
    const said = await callPlugin(
      env,
      id!,
      stub.compensate({ type, nodeId, stepKey, orderId, output }),
      `${type} (compensate)`,
    );
    return typeof said === 'string'
      ? (await scrubbed(env, id!, said)).slice(0, PLUGIN_SUMMARY_MAX)
      : 'Undone';
  };
}

/**
 * Delivers an outbound event over a plugin's binding, its data redacted unless the plugin is
 * granted buyer details. Never throws; the outbox retries.
 */
export async function deliverToPlugin(env: Env, id: string, payload: OutboundPayload) {
  let stub: Awaited<ReturnType<typeof plugin>>;
  try {
    stub = await plugin(env, id, 'serve');
  } catch (err) {
    return { ok: false, status: null, error: message(err) };
  }
  if (!stub) return { ok: false, status: null, error: missing(`${id}.*`) };
  const manifest = (await manifests(env)).find((m) => m.id === id);
  if (!manifest) return { ok: false, status: null, error: `Plugin “${id}” is not answering` };
  try {
    const data = pluginView(manifest, payload.data);
    await callPlugin(env, id, stub.deliver({ ...payload, data }), `${id}.deliver()`, 30_000);
    return { ok: true, status: 200, error: null };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const ENDED = TERMINAL_ORDER_STATUSES.filter((s) => s !== 'failed');

/**
 * What still depends on a plugin (its nodes, or a node naming it as Provider), so it isn't removed
 * from under a flow or a running order.
 */
export async function pluginUsage(env: Env, id: string): Promise<PluginUsage> {
  const d = createDb(env.DB);
  const usesIt = (json: string) => flowPlugins(JSON.parse(json) as FlowGraph).has(id);
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
    // A failed order may still be compensating its nodes: it counts until it is rolled back.
    .where(notInArray(orders.status, ENDED));
  const labels = await d
    .select({ id: shipments.id, orderId: shipments.orderId })
    .from(shipments)
    .where(and(eq(shipments.provider, id), eq(shipments.status, 'void_failed')));
  return {
    labels,
    flows: published.filter((f) => usesIt(f.json)).map(({ id, version }) => ({ id, version })),
    orders: running
      .filter((o) => usesIt(o.json))
      .map(({ id, flowId, version }) => ({ id, flowId, version })),
  };
}
