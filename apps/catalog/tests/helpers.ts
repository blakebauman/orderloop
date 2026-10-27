import { runDurableObjectAlarm } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import {
  DOC_FORMAT,
  PRODUCT_SHARDS,
  type ProductCatalogRpc,
  type ProductInput,
  type ProductTypeInput,
  paths,
} from '@orderloop/core/product';

/** The entrypoint as callers see it: through the contract in core, like the web app's binding. */
export const api = (exports as unknown as { CatalogApi: ProductCatalogRpc }).CatalogApi;
export const by = 'test@orderloop';

export const apparel: ProductTypeInput = {
  code: 'apparel',
  version: 1,
  attributes: [
    {
      code: 'material',
      kind: 'enum',
      filterable: true,
      card: true,
      values: [{ code: 'cotton', label: { en: 'Cotton', fr: 'Coton' } }, { code: 'wool' }],
    },
    {
      code: 'size',
      kind: 'enum',
      scope: 'variant',
      values: [{ code: 'S' }, { code: 'M' }, { code: 'L' }],
    },
  ],
  variantAxes: ['size'],
};

export const web = {
  code: 'web',
  name: 'Web',
  currency: 'USD',
  locales: ['en', 'fr'],
  defaultLocale: 'en',
};

let ready: Promise<void> | undefined;
/** Types, the channel and categories every test writes against. Idempotent across test files. */
export function setup() {
  ready ??= (async () => {
    const existing = await api.listTypes();
    if (!existing.some((t) => t.code === 'apparel')) {
      const r = await api.putType(apparel, by);
      if (!r.ok) throw new Error(r.issues.join('; '));
    }
    const ch = await api.putChannel(web, by);
    if (!ch.ok) throw new Error(ch.issues.join('; '));
    const cats = await api.putCategories(
      [
        { code: 'tops', name: { en: 'Tops', fr: 'Hauts' } },
        { code: 'tees', parent: 'tops', name: { en: 'Tees' } },
      ],
      by,
    );
    if (!cats.ok) throw new Error(cats.issues.join('; '));
  })();
  return ready;
}

/** A product with unique key and SKUs per call. */
let n = 0;
export function product(over: Partial<ProductInput> = {}): ProductInput {
  n++;
  const key = `p-${Date.now().toString(36)}-${n}`;
  return {
    key,
    type: 'apparel',
    title: { en: `Tee ${n}`, fr: `T-shirt ${n}` },
    slug: { en: `tee-${n}-${Date.now().toString(36)}` },
    categories: ['tees'],
    attributes: { material: 'cotton' },
    variants: [
      { sku: `${key}-S`, attributes: { size: 'S' } },
      { sku: `${key}-M`, attributes: { size: 'M' } },
    ],
    channels: { web: { visible: true, price: { amount: 1999, currency: 'USD' } } },
    ...over,
  };
}

/** Runs every shard's pending publish until nothing is left. */
export async function settle() {
  for (let pass = 0; pass < 20; pass++) {
    let busy = false;
    for (let i = 0; i < PRODUCT_SHARDS; i++) {
      const stub = env.SHARD.getByName(`shard-${i}`);
      if ((await stub.pending()) > 0) {
        busy = true;
        await runDurableObjectAlarm(stub);
      }
    }
    if (!busy) return;
  }
  throw new Error('shards never finished publishing');
}

export async function doc(key: string, locale = 'en') {
  const o = await env.PUBLISHED.get(paths.doc(DOC_FORMAT, 'web', locale, key));
  return o ? ((await o.json()) as Record<string, unknown>) : null;
}

export async function alias(a: string) {
  const o = await env.PUBLISHED.get(paths.alias(DOC_FORMAT, 'web', a));
  return o ? ((await o.json()) as { key: string }) : null;
}

/** Runs a Workflow instance to its end; its output, or its error thrown. */
export async function finish<T>(binding: Workflow, params?: unknown): Promise<T> {
  const instance = await binding.create(params === undefined ? undefined : { params });
  for (let i = 0; i < 1200; i++) {
    const s = await instance.status();
    if (s.status === 'complete') return s.output as T;
    if (s.status === 'errored' || s.status === 'terminated')
      throw new Error(`${s.status}: ${s.error?.message ?? ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the instance never finished');
}
