/**
 * Providers: a plugin doing a built-in node's work (its manifest's `provides`), picked by the node's
 * Provider field. The node keeps its own contract: the executor asks the provider for rates, a
 * label, tax or an address check, and applies the answer itself (totals, stock, shipment rows,
 * branches). Calls run inside the node's step, or while pricing a checkout for rates and tax; see
 * docs/plugins.md, "Providers".
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  checkProvideResult,
  type Order,
  PROVIDER_SURFACE_LABELS,
  type ProvideOutcome,
  type ProvideRequest,
  type ProviderSurface,
  pluginOrder,
  scrubCredentials,
} from '@orderloop/core';
import { knownSecretValues } from './plugin-host';
import { callPlugin, manifests, plugin } from './plugins';

type Ask = Extract<ProvideRequest, { surface: ProviderSurface }>;

/** A provider request as an executor builds it: the whole order, redacted here per manifest. */
export type ProviderCall<R extends Ask> = R extends { order: unknown }
  ? Omit<R, 'order'> & { order: Order }
  : R;

type Value<R extends Ask> = Extract<
  ReturnType<typeof checkProvideResult<R['surface'], R['op']>>,
  { kind: 'done' }
>['value'];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How long a provider may take while pricing a checkout (an agent is waiting), not in a step. */
const QUOTE_CALL_MS = 10_000;

/** Marks an error as a provider's, so checkout pricing can answer without passing its text on. */
function fromProvider<E extends Error>(err: E, id: string): E {
  return Object.assign(err, { provider: id });
}

/** The provider whose call failed, for an error `provide` threw; null for any other error. */
export const providerOfError = (err: unknown): string | null =>
  (err as { provider?: unknown } | null)?.provider === undefined
    ? null
    : String((err as { provider: unknown }).provider);

/**
 * Asks plugin `id` to do `req`. A provider that isn't installed, doesn't provide the surface or
 * returns something the contract doesn't allow fails for good; one that is bound but not answering,
 * or that fails with `retry: true`, fails this attempt, to be retried.
 */
export async function provide<R extends Ask>(
  env: Env,
  id: string,
  req: ProviderCall<R>,
): Promise<Value<R>> {
  const what = `${PROVIDER_SURFACE_LABELS[req.surface]} provider “${id}”`;
  const stub = await plugin(env, id);
  if (typeof stub?.provide !== 'function')
    throw fromProvider(new NonRetryableError(`${what} is not installed`), id);
  const manifest = (await manifests(env)).find((m) => m.id === id);
  if (!manifest) throw fromProvider(new Error(`${what} is not answering`), id);
  if (!manifest.provides.includes(req.surface))
    throw fromProvider(new NonRetryableError(`${what} doesn't provide ${req.surface}`), id);
  const sent = (
    'order' in req ? { ...req, order: pluginOrder(manifest, req.order as Order) } : req
  ) as ProvideRequest;
  const quoting = req.stepKey.startsWith('quote#');
  let result: unknown;
  try {
    result = await callPlugin(
      env,
      id,
      stub.provide(sent),
      `${id} (${req.surface} ${req.op})`,
      quoting ? QUOTE_CALL_MS : undefined,
    );
  } catch (err) {
    throw fromProvider(err instanceof Error ? err : new Error(message(err)), id);
  }
  let outcome: ProvideOutcome<Value<R>>;
  try {
    outcome = checkProvideResult(id, req.surface, req.op, result) as ProvideOutcome<Value<R>>;
  } catch (err) {
    // The same plugin code would return the same thing again: no retry.
    throw fromProvider(new NonRetryableError(message(err)), id);
  }
  if (outcome.kind === 'fail') {
    const failed = `${what}: ${scrubCredentials(outcome.message, await knownSecretValues(env, id))}`;
    throw fromProvider(outcome.retry ? new Error(failed) : new NonRetryableError(failed), id);
  }
  return outcome.value;
}
