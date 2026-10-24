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
} from '@orderloop/core';
import { manifests, plugin, withTimeout } from './plugins';

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
  const stub = plugin(env, id);
  if (!stub) throw new NonRetryableError(`${what} is not installed`);
  const manifest = (await manifests(env)).find((m) => m.id === id);
  if (!manifest) throw new Error(`${what} is not answering`);
  if (!manifest.provides.includes(req.surface))
    throw new NonRetryableError(`${what} doesn't provide ${req.surface}`);
  const sent = (
    'order' in req ? { ...req, order: pluginOrder(manifest, req.order as Order) } : req
  ) as ProvideRequest;
  const result = await withTimeout(stub.provide(sent), `${id} (${req.surface} ${req.op})`);
  let outcome: ProvideOutcome<Value<R>>;
  try {
    outcome = checkProvideResult(id, req.surface, req.op, result) as ProvideOutcome<Value<R>>;
  } catch (err) {
    // The same plugin code would return the same thing again: no retry.
    throw new NonRetryableError(message(err));
  }
  if (outcome.kind === 'fail') {
    const failed = `${what}: ${outcome.message}`;
    if (outcome.retry) throw new Error(failed);
    throw new NonRetryableError(failed);
  }
  return outcome.value;
}
