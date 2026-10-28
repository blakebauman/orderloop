/**
 * Fills a local catalog with a small demo shop whose Catalog page has a card in every column and
 * every kind of gap, so the board can be seen and tried without a feed of your own. Local only: it
 * calls `/api/v1/catalog` on the dev server, with `ORDERLOOP_API_TOKEN` (or the dev admin's token
 * from `pnpm db:seed:records`) once people are added. See docs/local-development.md, "Catalog demo
 * data".
 *
 *   pnpm db:seed:catalog [http://localhost:5173]
 *
 * It writes an `apparel` type, `web` and `stores` channels, `tops` and `bags` categories and 16
 * synthetic products, some missing French, German or Spanish text; then a feed with refused rows,
 * the assistant's drafts for review, staged edits, and two published products, one of which the
 * feed then contradicts (a conflict). Re-running it writes the same products again; what the board
 * shows then depends on what you did with the cards since.
 */

import { readLocalLogin } from './seed-lib';

type Json = Record<string, unknown>;

// `pnpm db:seed:catalog <url>` passes a `--` before the URL.
const origin = process.argv.slice(2).find((a) => a !== '--') ?? 'http://localhost:5173';
const base = `${origin.replace(/\/$/, '')}/api/v1/catalog`;
const token = process.env.ORDERLOOP_API_TOKEN ?? readLocalLogin()?.token;

async function call<T = Json>(
  method: string,
  path: string,
  body?: unknown,
  type = 'application/json',
): Promise<T> {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Setup that a previous run already made answers with an error; that's fine. */
const once = (what: string, p: Promise<unknown>) =>
  p.catch((e: Error) => console.log(`${what}: ${e.message.slice(0, 120)}`));

await once(
  'type',
  call('POST', 'types', {
    code: 'apparel',
    version: 1,
    attributes: [
      {
        code: 'material',
        kind: 'enum',
        values: [{ code: 'cotton' }, { code: 'wool' }, { code: 'canvas' }, { code: 'linen' }],
      },
      {
        code: 'size',
        kind: 'enum',
        scope: 'variant',
        values: [{ code: 'S' }, { code: 'M' }, { code: 'L' }],
      },
      { code: 'care', kind: 'text', localized: true },
      { code: 'fit', kind: 'text', localized: true },
    ],
    variantAxes: ['size'],
  }),
);
await once(
  'channel web',
  call('POST', 'channels', {
    code: 'web',
    name: 'Web',
    currency: 'USD',
    locales: ['en', 'fr', 'de'],
    defaultLocale: 'en',
  }),
);
await once(
  'channel stores',
  call('POST', 'channels', {
    code: 'stores',
    name: 'Stores',
    currency: 'USD',
    locales: ['en', 'es'],
    defaultLocale: 'en',
  }),
);
await once(
  'categories',
  call('POST', 'categories', {
    categories: [
      { code: 'tops', name: { en: 'Tops' } },
      { code: 'bags', name: { en: 'Bags' } },
    ],
  }),
);

// key, title, description, material, care
const ITEMS: [string, string, string, string, string][] = [
  [
    'merino-crew',
    'Merino crew sweater',
    'A midweight merino crew that layers under a coat.',
    'wool',
    'Hand wash cold, dry flat',
  ],
  [
    'waxed-tote',
    'Waxed canvas tote',
    'Waxed cotton canvas with leather handles. Takes a beating, ages well.',
    'canvas',
    'Wipe clean; rewax yearly',
  ],
  [
    'linen-shirt',
    'Linen camp shirt',
    'Washed linen with a relaxed camp collar.',
    'linen',
    'Machine wash cold',
  ],
  [
    'heavy-tee',
    'Heavyweight tee',
    'A 240 gsm cotton tee that holds its shape.',
    'cotton',
    'Machine wash cold',
  ],
  [
    'field-jacket',
    'Field jacket',
    'Four pockets, a cotton twill shell and a corduroy collar.',
    'cotton',
    'Dry clean',
  ],
  ['rib-beanie', 'Rib beanie', 'Merino rib knit, one size.', 'wool', 'Hand wash cold'],
  [
    'market-bag',
    'Market bag',
    'Net cotton bag that folds into its own pocket.',
    'cotton',
    'Machine wash warm',
  ],
  [
    'oxford-shirt',
    'Oxford button-down',
    'Soft oxford cloth, washed for a broken-in feel.',
    'cotton',
    'Machine wash cold',
  ],
  [
    'work-apron',
    'Canvas work apron',
    'Cross-back straps and three front pockets.',
    'canvas',
    'Spot clean',
  ],
  [
    'wool-scarf',
    'Lambswool scarf',
    'Brushed lambswool in a herringbone weave.',
    'wool',
    'Dry clean',
  ],
  [
    'denim-chore',
    'Denim chore coat',
    '12 oz rigid denim, blanket lined.',
    'cotton',
    'Wash inside out, cold',
  ],
  [
    'sling-bag',
    'Sling bag',
    'A small cross-body bag with a magnetic clasp.',
    'canvas',
    'Wipe clean',
  ],
  [
    'terry-hoodie',
    'Loopback hoodie',
    'French terry cotton with a lined hood.',
    'cotton',
    'Machine wash cold',
  ],
  [
    'polo-knit',
    'Knit polo',
    'Fine-gauge cotton knit with a three-button placket.',
    'cotton',
    'Hand wash cold',
  ],
  ['duffel-48', 'Weekend duffel', 'A 48-litre duffel with a shoe pocket.', 'canvas', 'Wipe clean'],
  [
    'cord-trouser',
    'Corduroy trouser',
    '8-wale corduroy, straight leg.',
    'cotton',
    'Machine wash cold',
  ],
];

/** A product with a spread of gaps: some lack French or German text, some Spanish for the stores. */
function product([key, title, description, material, care]: (typeof ITEMS)[number], i: number) {
  const fr = i % 3 !== 0;
  const de = i % 4 === 0;
  const es = i % 5 !== 1;
  const loc = (en: string, f?: string, d?: string, e?: string) => ({
    en,
    ...(fr && f ? { fr: f } : {}),
    ...(de && d ? { de: d } : {}),
    ...(es && e ? { es: e } : {}),
  });
  const price = { amount: 4500 + i * 500, currency: 'USD' };
  return {
    key,
    type: 'apparel',
    title: loc(title, `${title} (FR)`, `${title} (DE)`, `${title} (ES)`),
    description: loc(
      description,
      i % 2 ? `${description} [fr]` : undefined,
      undefined,
      i % 2 ? `${description} [es]` : undefined,
    ),
    slug: { en: key },
    categories: [/bag|tote|duffel/.test(key) ? 'bags' : 'tops'],
    media: [
      {
        src: `https://img.example/${key}-front.jpg`,
        alt: loc(`${title}, front`, i % 2 ? `${title}, devant` : undefined),
      },
      ...(i % 3 === 0
        ? [{ src: `https://img.example/${key}-detail.jpg`, alt: { en: `${title}, detail` } }]
        : []),
    ],
    attributes: { material, care: loc(care, i % 2 ? `${care} (fr)` : undefined) },
    variants: ['S', 'M', 'L'].map((s) => ({
      sku: `${key.toUpperCase()}-${s}`,
      attributes: { size: s },
    })),
    channels: {
      web: { visible: true, price },
      ...(i % 2 ? { stores: { visible: true, price } } : {}),
    },
  };
}

type Results = { results: { status?: string; ok?: boolean }[] };
const statuses = (r: Results) => r.results.map((x) => x.status ?? x.ok).join(',');

const products = ITEMS.map(product);
const byKey = (key: string) => products.find((p) => p.key === key) as (typeof products)[number];
console.log('products', statuses(await call<Results>('POST', 'products', { products })));

// A feed with refused rows: two new keys (one invalid) and an existing product sent broken.
const rows = [
  { ...byKey('heavy-tee'), title: { en: 'Heavyweight tee', fr: 'T-shirt épais' } },
  { key: 'canvas-cap', type: 'apparel', title: { en: 'Canvas cap' }, variants: [] },
  {
    key: 'Bad Key!',
    type: 'apparel',
    title: { en: 'Selvedge belt' },
    variants: [{ sku: 'BELT-1' }],
  },
  { ...byKey('market-bag'), variants: [] },
];
const feed = await call<{ feed: { id: string; state: string } }>(
  'POST',
  'feeds?format=ndjson&name=nightly-demo.ndjson',
  rows.map((r) => JSON.stringify(r)).join('\n'),
  'application/x-ndjson',
);
console.log('feed', feed.feed.id, feed.feed.state);

// Drafts the assistant would have written, for review.
const draft = (key: string, ref: Json, value: string) => ({
  key,
  ref,
  value,
  model: '@cf/moonshotai/kimi-k2.6',
});
const drafts = await call<Results>('POST', 'drafts', {
  drafts: [
    draft('merino-crew', { field: 'title', locale: 'fr' }, 'Pull col rond en mérinos'),
    draft(
      'merino-crew',
      { field: 'description', locale: 'fr' },
      'Un pull en mérinos de poids moyen, à porter sous un manteau.',
    ),
    draft(
      'field-jacket',
      { field: 'description', locale: 'fr' },
      'Quatre poches, une coque en sergé de coton et un col en velours côtelé.',
    ),
    draft('oxford-shirt', { field: 'title', locale: 'fr' }, 'Chemise oxford à col boutonné'),
  ],
});
console.log('drafts', statuses(drafts));

// Edits staged and waiting to publish.
const set = (key: string, ref: Json, value: string) => ({ key, ref, op: 'set', value });
const staged = await call<Results>('POST', 'edits', {
  edits: [
    set('linen-shirt', { field: 'title', locale: 'de' }, 'Leinen-Campshirt'),
    set(
      'wool-scarf',
      { field: 'description', locale: 'fr' },
      'Écharpe en laine d’agneau brossée, tissage à chevrons.',
    ),
    set('sling-bag', { field: 'title', locale: 'es' }, 'Bolso bandolera'),
  ],
});
console.log('staged', statuses(staged));

// Published today, then one of them contradicted by the feed: a conflict.
await call('POST', 'edits', {
  edits: [
    set('rib-beanie', { field: 'title', locale: 'fr' }, 'Bonnet côtelé en mérinos'),
    set('market-bag', { field: 'title', locale: 'es' }, 'Bolsa de mercado'),
  ],
});
const published = await call<Results>('POST', 'edits/publish', {
  keys: ['rib-beanie', 'market-bag'],
});
console.log('published', statuses(published));
const beanie = byKey('rib-beanie');
await call('POST', 'products', {
  products: [{ ...beanie, title: { ...beanie.title, fr: 'Bonnet en côte' } }],
});

const board = await call<{ board: { columns: Json } }>('GET', 'board');
console.log('board', JSON.stringify(board.board.columns));
console.log(`Open ${origin}/catalog`);
