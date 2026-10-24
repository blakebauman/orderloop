/**
 * The Durable Object namespaces, in the deployment's jurisdiction. Where the registry sets one
 * (`DATA_JURISDICTION`, e.g. `eu`), every order, assistant and A2A object is created and kept
 * there, as D1 and R2 already are; empty leaves them where Cloudflare places them. Everything that
 * reaches an object goes through here (tests/namespaces.test.ts checks), since an object reached
 * without the jurisdiction is a different, empty one.
 *
 * Set it only before a deployment's first order: changing it later strands what exists.
 */

const JURISDICTIONS = ['eu', 'fedramp'] as const;
type Jurisdiction = (typeof JURISDICTIONS)[number];

function jurisdictionOf(env: Env): Jurisdiction | null {
  const j = env.DATA_JURISDICTION as string;
  if (!j) return null;
  if (!(JURISDICTIONS as readonly string[]).includes(j))
    throw new Error(`DATA_JURISDICTION must be one of ${JURISDICTIONS.join(', ')}, or empty`);
  return j as Jurisdiction;
}

function scope<T extends Rpc.DurableObjectBranded | undefined>(
  env: Env,
  ns: DurableObjectNamespace<T>,
): DurableObjectNamespace<T> {
  const j = jurisdictionOf(env);
  return j ? ns.jurisdiction(j) : ns;
}

export const orderAgent = (env: Env, orderId: string) =>
  scope(env, env.ORDER_AGENT).getByName(orderId);

export const a2aAgent = (env: Env, name: string) => scope(env, env.A2A_AGENT).getByName(name);

/** A sandboxed plugin's own storage, in the deployment's jurisdiction like every other object. */
export const pluginStorage = (env: Env, pluginId: string) =>
  scope(env, env.PLUGIN_STORAGE).getByName(pluginId);

/** `env` with each namespace in the jurisdiction, for the Agents SDK's own routing. */
export const scopedEnv = (env: Env): Env => ({
  ...env,
  ORDER_AGENT: scope(env, env.ORDER_AGENT),
  ASSISTANT_AGENT: scope(env, env.ASSISTANT_AGENT),
  A2A_AGENT: scope(env, env.A2A_AGENT),
});
