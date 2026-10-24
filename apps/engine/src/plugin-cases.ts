/**
 * Test cases for an assistant-drafted rule plugin: each runs the rule in the sandbox, as the
 * engine would run its node (a redacted order, the node's config with its defaults, the result
 * checked by `checkExecResult`), and says whether it took the branch (and set the variables) the
 * case expects. An admin can only approve a draft whose cases all pass. See docs/plugins.md,
 * "Assistant-drafted plugins".
 */

import {
  boundText,
  checkExecResult,
  PLUGIN_LIMIT_CAPS,
  type PluginCase,
  type PluginCaseResult,
  type PluginExecRequest,
  type PluginManifest,
  type PluginRpc,
  sampleRedactedOrder,
} from '@orderloop/core';

/**
 * The bundle's code loaded with nothing: no network, no storage, no secrets. `limits` are a node
 * call's, so a rule that loops in a case is stopped as it would be on an order.
 */
export function bareSandbox(
  env: Env,
  code: string,
  limits: { cpuMs: number } = PLUGIN_LIMIT_CAPS.call,
) {
  const worker = env.LOADER.load({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js',
    modules: { 'index.js': code },
    env: { __ORDERLOOP_SANDBOX: true },
    globalOutbound: null,
  } as unknown as WorkerLoaderWorkerCode);
  return worker.getEntrypoint(undefined, {
    limits: { cpuMs: limits.cpuMs, subRequests: 0 },
  }) as unknown as PluginRpc;
}

/** JSON with object keys in order, so equal values compare equal however they were built. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** A fresh id, title and date each run, so a rule can't tell a case from an order by them. */
const caseOrder = (over: Record<string, unknown>) => {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return sampleRedactedOrder({
    id: `ord_${n.toString(36)}`,
    title: `Order ${n % 100_000}`,
    createdAt: Date.now() - (n % 30) * 86_400_000,
    ...over,
  });
};

/** Runs every case on `code`; a case naming a node the manifest lacks fails. */
export async function runCases(
  env: Env,
  code: string,
  manifest: PluginManifest,
  cases: PluginCase[],
): Promise<PluginCaseResult[]> {
  // The draft's own limits: a rule that passes its cases fits on an order too.
  const stub = bareSandbox(env, code, {
    cpuMs: manifest.limits.cpuMs ?? PLUGIN_LIMIT_CAPS.call.cpuMs,
  });
  const out: PluginCaseResult[] = [];
  for (const c of cases) {
    const type = `${manifest.id}.${c.node}`;
    const node = manifest.nodes.find((n) => n.type === type);
    const fail = (error: string): PluginCaseResult => ({
      ...c,
      pass: false,
      got: { branch: null, error: boundText(error, 300) ?? 'failed' },
    });
    if (!node) {
      out.push(fail(`${manifest.name} has no step “${c.node}”`));
      continue;
    }
    const defaults = Object.fromEntries(
      node.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]),
    );
    try {
      const order = caseOrder(c.order);
      const req: PluginExecRequest = {
        type,
        nodeId: 'rule',
        stepKey: `rule#${out.length}`,
        orderId: order.id,
        config: { ...defaults, ...c.config },
        order,
        vars: {},
        nodes: {},
      };
      const r = checkExecResult(type, await stub.execute(req), node.outputs);
      if (r.kind === 'fail') {
        out.push(fail(r.message));
        continue;
      }
      const pass =
        r.branch === c.expect.branch &&
        (c.expect.vars === undefined ||
          Object.entries(c.expect.vars).every(([k, v]) => same(r.vars?.[k], v)));
      out.push({ ...c, pass, got: { branch: r.branch, ...(r.vars ? { vars: r.vars } : {}) } });
    } catch (err) {
      out.push(fail(err instanceof Error ? err.message : String(err)));
    }
  }
  return out;
}
