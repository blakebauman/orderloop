/**
 * Measures a deployment's product catalog end to end: streams a generated feed of N products
 * through the REST API, times the import and how long until every product is published and listed
 * on the public catalog, samples catalog-edge latencies (cache misses and hits), then deletes the
 * products and checks nothing is still served. See docs/testing.md, "Catalog benchmark".
 *
 *   ORDERLOOP_API_TOKEN=ol_… node scripts/catalog-bench.ts <deployment id> [products] [--keep]
 *   ORDERLOOP_API_TOKEN=ol_… node scripts/catalog-bench.ts <deployment id> --cleanup [products]
 *
 * `products` defaults to 50,000. The token must be an operator's or an admin's. Everything it
 * writes is in its own channel (`bench`), type (`bench-apparel`) and categories (`bench-*`), with
 * keys `bench-0000000` up, so it never touches a storefront's catalog. `--keep` leaves the products
 * in place; `--cleanup` only deletes them (after a run that was stopped). The channel, type and
 * categories are kept for the next run.
 */

import { fileURLToPath } from 'node:url';
import { loadDeployments } from './fleet.ts';

export const CHANNEL = 'bench';
export const TYPE = 'bench-apparel';
const ROOT = 'bench-shop';
export const LEAVES = [
  'bench-tees',
  'bench-layers',
  'bench-outerwear',
  'bench-hats',
  'bench-bottoms',
];
/** Products per delete call (the API's limit), and calls a second (its budget is ~600 a minute). */
const DELETE_BATCH = 500;
const DELETE_RATE = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const key = (i: number) => `bench-${String(i).padStart(7, '0')}`;

function fail(message: string): never {
  console.error(`catalog-bench: ${message}`);
  process.exit(1);
}

/** Where the run sends its calls: set by `main` from the command line. */
let APP = '';
let EDGE = '';
let token = '';
let id = '';
let count = 0;

/** A REST call, waiting out rate limits. */
async function api(
  method: string,
  path: string,
  body?: BodyInit,
  type = 'application/json',
): Promise<{ status: number; json: Record<string, unknown> }> {
  for (;;) {
    const r = await fetch(`${APP}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': type },
      body,
      // A streamed body needs half duplex in Node's fetch.
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
    // A streamed body (the feed) has been read and can't be sent again: its refusal is reported.
    if (r.status === 429 && !(body instanceof ReadableStream)) {
      await sleep(1000 * Number(r.headers.get('retry-after') ?? 2));
      continue;
    }
    return {
      status: r.status,
      json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }
}

type EdgeBody = { total?: number; next?: string | null; products?: unknown[] } | null;

async function edge(
  path: string,
): Promise<{ status: number; ms: number; cache: string; body: EdgeBody }> {
  const t = performance.now();
  const r = await fetch(`${EDGE}/${path}`);
  const body = (await r.json().catch(() => null)) as EdgeBody;
  return {
    status: r.status,
    ms: performance.now() - t,
    cache: r.headers.get('cf-cache-status') ?? '',
    body,
  };
}

/**
 * The root listing's total. Each poll asks for a different page size, a different cache key, so
 * it isn't a copy cached by an earlier poll; it still trails the published index by up to the
 * index's own rebuild delay.
 */
let polls = 0;
async function listed(): Promise<number | null> {
  const r = await edge(`categories/${ROOT}/products?limit=${(polls++ % 100) + 1}`);
  // No such category yet (nothing ever listed in it) counts as empty.
  if (r.status === 404) return 0;
  return r.status === 200 ? (r.body?.total ?? 0) : null;
}

async function setup() {
  const types = await api('GET', 'types');
  if (types.status !== 200) fail(`GET types answered ${types.status}: check the token`);
  if (!(types.json.types as { code: string }[]).some((t) => t.code === TYPE)) {
    const values = (codes: string[]) => codes.map((code) => ({ code }));
    const t = await api(
      'POST',
      'types',
      JSON.stringify({
        code: TYPE,
        version: 1,
        label: { en: 'Benchmark apparel' },
        attributes: [
          {
            code: 'material',
            kind: 'enum',
            filterable: true,
            card: true,
            values: values(MATERIALS),
          },
          { code: 'color', kind: 'enum', filterable: true, values: values(COLORS) },
          {
            code: 'size',
            kind: 'enum',
            scope: 'variant',
            filterable: true,
            values: values(['S', 'M']),
          },
        ],
        variantAxes: ['size'],
      }),
    );
    if (t.status !== 201)
      fail(`creating type ${TYPE} answered ${t.status}: ${JSON.stringify(t.json)}`);
  }
  const c = await api(
    'POST',
    'channels',
    JSON.stringify({
      code: CHANNEL,
      name: 'Benchmark (scripts/catalog-bench.ts)',
      currency: 'USD',
      locales: ['en'],
      defaultLocale: 'en',
    }),
  );
  if (c.status !== 200) fail(`saving channel ${CHANNEL} answered ${c.status}`);
  const categories = [
    { code: ROOT, name: { en: 'Benchmark shop' } },
    ...LEAVES.map((code) => ({ code, parent: ROOT, name: { en: code } })),
  ];
  const k = await api('POST', 'categories', JSON.stringify({ categories }));
  if (k.status !== 200) fail(`saving categories answered ${k.status}`);
}

const BRANDS = [
  'Northwind',
  'Fabrikam',
  'Contoso',
  'Tailspin',
  'Litware',
  'Adatum',
  'Wingtip',
  'Coho',
];
const NOUNS = ['tee', 'hoodie', 'cap', 'jacket', 'sweater', 'polo', 'beanie', 'shorts'];
const ADJECTIVES = ['classic', 'merino', 'organic', 'vintage', 'relaxed', 'oversized', 'quilted'];
const LEAF: Record<string, string> = {
  tee: 'bench-tees',
  polo: 'bench-tees',
  hoodie: 'bench-layers',
  sweater: 'bench-layers',
  jacket: 'bench-outerwear',
  cap: 'bench-hats',
  beanie: 'bench-hats',
  shorts: 'bench-bottoms',
};
export const MATERIALS = ['cotton', 'wool', 'linen', 'polyester'];
export const COLORS = ['red', 'blue', 'black', 'white', 'green'];

/** The feed as CSV, generated as it is sent: two variant rows a product, seeded, so runs compare. */
export function feed(n: number): ReadableStream<Uint8Array> {
  let seed = 1_000;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const encoder = new TextEncoder();
  let i = -1;
  return new ReadableStream({
    pull(c) {
      if (i === -1) {
        c.enqueue(
          encoder.encode(
            `key,type,title:en,brand,categories,price.${CHANNEL},sku,attr.material,attr.color,attr.size\n`,
          ),
        );
        i = 0;
        return;
      }
      if (i >= n) return c.close();
      const lines: string[] = [];
      for (const end = Math.min(n, i + 1_000); i < end; i++) {
        const noun = pick(NOUNS);
        const k = key(i);
        const title = `${pick(ADJECTIVES)} ${pick(COLORS)} ${noun} ${i}`;
        const price = (5 + Math.floor(rand() * 195)).toFixed(2);
        lines.push(
          `${k},${TYPE},"Bench ${title}",${pick(BRANDS)},${LEAF[noun]},${price},${k.toUpperCase()}-S,${pick(MATERIALS)},${pick(COLORS)},S`,
          `${k},,,,,,${k.toUpperCase()}-M,,,M`,
        );
      }
      c.enqueue(encoder.encode(`${lines.join('\n')}\n`));
    },
  });
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

async function run() {
  await setup();
  const before = await listed();
  if (before) fail(`${before} products are already listed in ${ROOT}: run with --cleanup first`);
  const t0 = Date.now();
  const started = await api(
    'POST',
    `feeds?format=csv&name=bench-${count}.csv`,
    feed(count),
    'text/csv',
  );
  const feedId = (started.json.feed as { id?: string } | undefined)?.id;
  if (started.status !== 202 || !feedId)
    fail(`the feed was refused (${started.status}): ${JSON.stringify(started.json)}`);
  const uploaded = Date.now() - t0;
  console.log(`uploaded ${count} products in ${seconds(uploaded)} s (feed ${feedId})`);

  let imported = 0;
  let lastListed = 0;
  for (;;) {
    await sleep(5_000);
    const s = (await api('GET', `feeds/${feedId}`)).json.feed as Record<string, number | string>;
    const n = await listed();
    if (n !== null) lastListed = n;
    console.log(
      `${seconds(Date.now() - t0)} s  ${s.state}  imported ${s.created}/${count}  listed ${n ?? '-'}`,
    );
    if (s.state === 'failed' || s.state === 'cancelled')
      fail(`the feed ${s.state}: ${s.failure ?? ''}`);
    if (!imported && s.state === 'done') {
      imported = Date.now() - t0;
      if (Number(s.rejected)) console.log(`  ${s.rejected} rows rejected`);
    }
    if (imported && lastListed >= count) break;
  }
  const published = Date.now() - t0;

  // Latencies: a miss is a page no one asked for yet (an unused page size), a hit the same again.
  const samples: Record<string, number[]> = {};
  const time = async (label: string, path: string) => {
    const r = await edge(path);
    if (r.status !== 200) console.log(`  ${label}: ${r.status}`);
    const list = samples[label] ?? [];
    list.push(r.ms);
    samples[label] = list;
    return r;
  };
  const rand = Math.floor(Math.random() * 1_000);
  for (let s = 0; s < 5; s++) {
    const limit = ((rand + s * 13) % 97) + 2;
    await time('root listing, miss', `categories/${ROOT}/products?limit=${limit}`);
    await time('root listing, hit', `categories/${ROOT}/products?limit=${limit}`);
    const first = await time(
      'filtered + sorted, miss',
      `categories/${ROOT}/products?f.material=wool&f.color=red&sort=price_desc&limit=${limit}`,
    );
    if (first.body?.next)
      await time(
        'next page, miss',
        `categories/${ROOT}/products?f.material=wool&f.color=red&sort=price_desc&limit=${limit}&cursor=${first.body.next}`,
      );
    await time('leaf listing, miss', `categories/${LEAVES[s]}/products?f.size=M&limit=${limit}`);
    await time(
      'search, miss',
      `search?q=${encodeURIComponent(`${ADJECTIVES[s]} ${NOUNS[s]}`)}&limit=${limit}`,
    );
    await time('product, miss', `products/${key((rand * 7 + s * 997) % count)}`);
  }
  const report = {
    deployment: id,
    products: count,
    uploadSeconds: seconds(uploaded),
    importSeconds: seconds(imported),
    publishedSeconds: seconds(published),
    productsPerSecond: Math.round(count / (published / 1000)),
    latencyMs: Object.fromEntries(
      Object.entries(samples).map(([label, ms]) => {
        const sorted = [...ms].sort((a, b) => a - b);
        const at = (p: number) =>
          Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);
        return [label, { p50: at(0.5), max: at(1), n: sorted.length }];
      }),
    ),
  };
  console.log(JSON.stringify(report, null, 2));
}

async function cleanup() {
  const t0 = Date.now();
  let deleted = 0;
  for (let from = 0; from < count; from += DELETE_BATCH * DELETE_RATE) {
    const t = Date.now();
    const calls = [];
    for (let s = from; s < Math.min(count, from + DELETE_BATCH * DELETE_RATE); s += DELETE_BATCH) {
      const keys = Array.from({ length: Math.min(DELETE_BATCH, count - s) }, (_, j) => key(s + j));
      calls.push(api('POST', 'products/delete', JSON.stringify({ keys })));
    }
    for (const r of await Promise.all(calls))
      deleted += ((r.json.results as { status: string }[] | undefined) ?? []).filter(
        (x) => x.status === 'deleted',
      ).length;
    await sleep(Math.max(0, 1000 - (Date.now() - t)));
  }
  console.log(`deleted ${deleted} products in ${seconds(Date.now() - t0)} s`);
  for (let i = 0; ; i++) {
    const n = await listed();
    if (n === 0) break;
    if (i >= 120) fail(`${n} products still listed after 10 minutes`);
    await sleep(5_000);
  }
  // Every deleted product is gone from the edge, cards included.
  const sample = Array.from({ length: Math.min(100, count) }, (_, j) =>
    key(Math.floor((j * count) / Math.min(100, count))),
  );
  const batch = await edge(`products?keys=${sample.join(',')}`);
  const left = ((batch.body?.products as unknown[]) ?? []).filter((p) => p !== null).length;
  if (left) fail(`${left} of ${sample.length} deleted products are still served`);
  console.log(
    `listing empty and none of ${sample.length} sampled products served after ${seconds(Date.now() - t0)} s`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  id = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '';
  count = Number(args.find((a) => /^\d+$/.test(a)) ?? 50_000);
  const keep = args.includes('--keep');
  const cleanupOnly = args.includes('--cleanup');
  if (!id) fail('usage: catalog-bench.ts <deployment id> [products] [--keep | --cleanup]');
  if (count < 1 || count > 10_000_000) fail('products must be between 1 and 10,000,000');
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: run by hand, not as a turbo task.
  token = process.env.ORDERLOOP_API_TOKEN ?? '';
  if (!token) fail("ORDERLOOP_API_TOKEN not set: use an operator's or admin's API token");
  const deployment = loadDeployments().find((d) => d.id === id);
  if (!deployment) fail(`no deployment ${JSON.stringify(id)} in deployments/`);
  APP = `https://${deployment.domain}/api/v1/catalog`;
  EDGE = `https://${deployment.catalogDomain}/v1/${CHANNEL}/en`;
  try {
    if (!cleanupOnly) await run();
    if (!keep) await cleanup();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// Run from the command line; imported (the tests), it only exports.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
