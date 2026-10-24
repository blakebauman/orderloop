/**
 * What every write and every render needs from CatalogMeta: product types (all versions) and
 * channels. Callers hold it per isolate and refresh when `rev` moves, so the hot path never waits
 * on the metadata object.
 */
import type { Channel, ProductType } from '@orderloop/core/product';
import { productShard } from '@orderloop/core/product';

export type CatalogConfig = {
  /** Increments on every type or channel change. */
  rev: number;
  types: ProductType[];
  channels: Channel[];
};

export type TypeResolver = (code: string, version?: number) => ProductType | undefined;

/** Looks a type up by code and version; without a version, the latest. */
export function typeResolver(config: CatalogConfig): TypeResolver {
  const byCode = new Map<string, ProductType[]>();
  for (const t of config.types) {
    const list = byCode.get(t.code) ?? [];
    list.push(t);
    byCode.set(t.code, list);
  }
  for (const list of byCode.values()) list.sort((a, b) => a.version - b.version);
  return (code, version) => {
    const list = byCode.get(code);
    if (!list) return undefined;
    return version === undefined ? list[list.length - 1] : list.find((t) => t.version === version);
  };
}

const JURISDICTIONS = ['eu', 'fedramp'] as const;

/** A namespace in the deployment's jurisdiction: an object reached without it is a different one. */
function scope<T extends Rpc.DurableObjectBranded | undefined>(
  env: Env,
  ns: DurableObjectNamespace<T>,
): DurableObjectNamespace<T> {
  const j = env.DATA_JURISDICTION as string;
  if (!j) return ns;
  if (!(JURISDICTIONS as readonly string[]).includes(j))
    throw new Error(`DATA_JURISDICTION must be one of ${JURISDICTIONS.join(', ')}, or empty`);
  return ns.jurisdiction(j as (typeof JURISDICTIONS)[number]);
}

// Every object goes through here: one reached without the jurisdiction is a different, empty one.
export const meta = (env: Env) => scope(env, env.META).getByName('meta');
export const shard = (env: Env, n: number) => scope(env, env.SHARD).getByName(`shard-${n}`);
export const feeds = (env: Env) => scope(env, env.FEEDS).getByName('feeds');
export const indexer = (env: Env, channel: string, category: string) =>
  scope(env, env.LISTINGS).getByName(`${channel}:${category}`);
export const searcher = (env: Env, n: number) => scope(env, env.SEARCH).getByName(`search-${n}`);
export const shardFor = (env: Env, key: string) => shard(env, productShard(key));
