import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  EXTRACT_CANDIDATES,
  EXTRACT_CATALOG_TOKENS,
  estimateTokens,
  type Order,
  type RunContext,
} from '@orderloop/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { EXECUTORS } from '../src/nodes';
import { EMBEDDING_MODEL, extractCatalog, reindexProducts } from '../src/product-index';

/**
 * What `ai.extract` shows the model: the whole catalog while it is small, and for a catalog of
 * thousands, the SKUs the document names, the names it shares words with and (with the product
 * index bound) what the index finds for its lines, within a fixed token budget. The large catalog
 * is its own database (EXTRACT_DB), so other tests keep ordering against the demo data. The model
 * and the index are stubs that record what they were sent.
 */

const testEnv = env as Env & { EXTRACT_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const BULK = 5_000;
const sku = (i: number) => `BLK-${String(i).padStart(5, '0')}`;
const SHAPES = ['bracket', 'flange', 'spacer', 'bushing', 'collar'];

beforeAll(async () => {
  const db = testEnv.EXTRACT_DB;
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  const insert = db.prepare('INSERT INTO products (sku, name, price, cost) VALUES (?, ?, 1, 0)');
  const rows: [string, string][] = [
    ...Array.from({ length: BULK }, (_, i): [string, string] => [
      sku(i),
      `Steel ${SHAPES[i % SHAPES.length]} ${i}`,
    ]),
    ['VLV-220', 'Brass ball valve 1/2"'],
    ['PMP-900', 'Centrifugal pump 2HP'],
  ];
  for (let i = 0; i < rows.length; i += 500)
    await db.batch(rows.slice(i, i + 500).map((r) => insert.bind(...r)));
});

type Sent = {
  model: string;
  input: Record<string, unknown>;
  options?: { gateway?: { id: string; collectLog?: boolean } };
};

/** A live-mode env on the large catalog: a model stub, and the index stub when given. */
function live(reply: unknown, index?: Partial<VectorizeIndex>) {
  const sent: Sent[] = [];
  const e = {
    ...env,
    DB: testEnv.EXTRACT_DB,
    AI_MODE: 'live',
    AI_GATEWAY_ID: 'gw-test',
    AI: {
      run: async (model: string, input: Record<string, unknown>, options?: Sent['options']) => {
        sent.push({ model, input, options });
        if (model === EMBEDDING_MODEL)
          return { data: (input.text as string[]).map(() => new Array(768).fill(0.01)) };
        return { response: reply };
      },
    },
    PRODUCT_VECTORS: index,
  } as unknown as Env;
  return { env: e, sent };
}

const mock = (e: Env) => ({ ...e, AI_MODE: 'mock' }) as unknown as Env;

/** The catalog block of the extract prompt the model was sent. */
function promptCatalog(sent: Sent[]) {
  const call = sent.find((s) => s.model !== EMBEDDING_MODEL)!;
  const user = (call.input.messages as { content: string }[])[1]!.content;
  const block = /<data source="catalog">\n([\s\S]*?)\n<\/data>/.exec(user)![1]!;
  return { user, block, catalog: JSON.parse(block) as { sku: string; name: string }[] };
}

const node = {
  id: 'extract',
  type: 'ai.extract',
  label: 'Extract',
  config: {},
  position: { x: 0, y: 0 },
};

function extract(e: Env, documentText: string) {
  const order: Order = {
    id: `ord_ext_${crypto.randomUUID().slice(0, 8)}`,
    model: 'b2b',
    channel: 'email',
    currency: 'USD',
    lines: [],
    meta: {},
    createdAt: Date.now(),
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
    documentText,
  };
  const ctx: RunContext = { order, nodes: {}, vars: {}, input: {}, now: Date.now(), ref: order.id };
  return EXECUTORS['ai.extract']!({ env: e, node, config: {}, ctx, stepKey: 'extract#1' });
}

const DOC = 'PO 7781\nPlease send 3 x BLK-00042\nand 2 brass ball valves.\nThanks';

describe('ai.extract on a small catalog', () => {
  it('shows the whole demo catalog, what the document names first', async () => {
    const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>();
    expect(all!.n).toBeLessThanOrEqual(EXTRACT_CANDIDATES);
    const catalog = await extractCatalog(env, 'Need 3 gasket kits');
    expect(catalog).toHaveLength(all!.n);
    expect(catalog[0]!.sku).toBe('GSK-010');
  });

  it('extracts in mock mode with no index bound', async () => {
    const r = await extract(env, 'PO 5521\n3 x GSK-010');
    expect(r.order?.lines).toEqual([{ sku: 'GSK-010', qty: 3 }]);
  });
});

describe(`ai.extract on ${BULK.toLocaleString('en-US')} SKUs`, () => {
  const reply = {
    customerName: null,
    poNumber: '7781',
    lines: [
      { sku: 'BLK-00042', qty: 3 },
      { sku: 'VLV-220', qty: 2 },
      // A real SKU the document never mentions: not among the candidates, so held back.
      { sku: sku(4_321), qty: 1 },
    ],
    notes: null,
  };

  it('keeps the prompt within its budget without the index', async () => {
    const { env: e, sent } = live(reply);
    const r = await extract(e, DOC);
    expect(sent.map((s) => s.model)).not.toContain(EMBEDDING_MODEL);
    const { user, block, catalog } = promptCatalog(sent);
    expect(catalog.map((c) => c.sku).slice(0, 2)).toEqual(['BLK-00042', 'VLV-220']);
    expect(catalog.length).toBeLessThanOrEqual(EXTRACT_CANDIDATES + 1);
    expect(estimateTokens(block)).toBeLessThanOrEqual(EXTRACT_CATALOG_TOKENS);
    // The whole table would be ~60,000 tokens; the model's context is 24k.
    expect(estimateTokens(user)).toBeLessThan(EXTRACT_CATALOG_TOKENS + 1_000);
    expect(r.output).toMatchObject({ source: 'model' });
    expect(r.order?.lines).toEqual([
      { sku: 'BLK-00042', qty: 3 },
      { sku: 'VLV-220', qty: 2 },
    ]);
    expect((r.output as { rejected: { sku: string }[] }).rejected.map((x) => x.sku)).toEqual([
      sku(4_321),
    ]);
  });

  it('adds what the index finds for the document’s lines, through the gateway', async () => {
    const queried: number[][] = [];
    const { env: e, sent } = live(
      { customerName: null, poNumber: null, lines: [{ sku: 'PMP-900', qty: 1 }], notes: null },
      {
        query: async (v: number[]) => {
          queried.push(v);
          // A SKU deleted since it was indexed comes back too, until the next reindex.
          return {
            matches: [
              { id: 'PMP-900', score: 0.82 },
              { id: 'GONE-1', score: 0.9 },
            ],
            count: 2,
          } as VectorizeMatches;
        },
      },
    );
    const r = await extract(e, 'We need something to move water out of the basement, x1');
    const embedding = sent.find((s) => s.model === EMBEDDING_MODEL)!;
    expect(embedding.input).toMatchObject({ pooling: 'cls' });
    expect(embedding.options).toEqual({ gateway: { id: 'gw-test', collectLog: false } });
    expect(queried).toHaveLength((embedding.input.text as string[]).length);
    const { catalog } = promptCatalog(sent);
    expect(catalog[0]!.sku).toBe('PMP-900');
    expect(catalog.map((c) => c.sku)).not.toContain('GONE-1');
    expect(r.order?.lines).toEqual([{ sku: 'PMP-900', qty: 1 }]);
  });

  it('falls back to words when the index fails', async () => {
    const { env: e, sent } = live(reply, {
      query: async () => {
        throw new Error('index unavailable');
      },
    });
    const r = await extract(e, DOC);
    expect(promptCatalog(sent).catalog[0]!.sku).toBe('BLK-00042');
    expect(r.order?.lines).toHaveLength(2);
  });

  it('never calls the index in mock mode', async () => {
    let calls = 0;
    const { env: e } = live(reply, {
      query: async () => {
        calls++;
        return { matches: [], count: 0 } as VectorizeMatches;
      },
    });
    const r = await extract(mock(e), 'PO 7781\n4 x VLV-220');
    expect(calls).toBe(0);
    expect(r.order?.lines).toEqual([{ sku: 'VLV-220', qty: 4 }]);
  });
});

describe('reindexProducts', () => {
  /** An index stub that records its writes. */
  function index() {
    const upserted: VectorizeVector[] = [];
    const deleted: string[] = [];
    const stub: Partial<VectorizeIndex> = {
      upsert: async (v) => {
        upserted.push(...v);
        return { ids: v.map((x) => x.id), count: v.length } as never;
      },
      deleteByIds: async (ids) => {
        deleted.push(...ids);
        return { ids, count: ids.length } as never;
      },
    };
    return { stub, upserted, deleted };
  }

  it('fills the index over runs, then writes only what changed', async () => {
    const { stub, upserted, deleted } = index();
    const { env: e, sent } = live(null, stub);
    const total = BULK + 2;

    const first = await reindexProducts(e, 3_000);
    expect(first).toEqual({ indexed: 3_000, removed: 0, more: true });
    const second = await reindexProducts(e, 3_000);
    expect(second).toEqual({ indexed: total - 3_000, removed: 0, more: false });
    expect(new Set(upserted.map((v) => v.id)).size).toBe(total);
    expect(upserted.find((v) => v.id === 'VLV-220')!.metadata).toEqual({
      name: 'Brass ball valve 1/2"',
    });
    // Batches of 100 texts, each "SKU name", with cls pooling through the gateway.
    expect(sent.every((s) => (s.input.text as string[]).length <= 100)).toBe(true);
    expect(sent[0]!.input.pooling).toBe('cls');
    expect((sent[0]!.input.text as string[])[0]).toBe(`${sku(0)} Steel bracket 0`);
    expect(sent[0]!.options).toEqual({ gateway: { id: 'gw-test', collectLog: false } });

    // Nothing changed: nothing written. A run repeats harmlessly.
    upserted.length = 0;
    expect(await reindexProducts(e)).toEqual({ indexed: 0, removed: 0, more: false });
    expect(upserted).toEqual([]);

    // A rename re-embeds that SKU alone; a deleted SKU's vector goes.
    const db = testEnv.EXTRACT_DB;
    await db
      .prepare("UPDATE products SET name = 'Steel flange, zinc' WHERE sku = ?")
      .bind(sku(1))
      .run();
    await db.prepare('DELETE FROM products WHERE sku = ?').bind(sku(2)).run();
    expect(await reindexProducts(e)).toEqual({ indexed: 1, removed: 1, more: false });
    expect(upserted.map((v) => v.id)).toEqual([sku(1)]);
    expect(deleted).toEqual([sku(2)]);
    expect(await reindexProducts(e)).toEqual({ indexed: 0, removed: 0, more: false });
  });

  it('records nothing when the index write fails, so the next run retries', async () => {
    const db = testEnv.EXTRACT_DB;
    await db
      .prepare("UPDATE products SET name = 'Steel spacer, nylon' WHERE sku = ?")
      .bind(sku(3))
      .run();
    const { env: broken } = live(null, {
      upsert: async () => {
        throw new Error('write failed');
      },
    });
    await expect(reindexProducts(broken)).rejects.toThrow('write failed');
    const { stub, upserted } = index();
    expect(await reindexProducts(live(null, stub).env)).toMatchObject({ indexed: 1 });
    expect(upserted.map((v) => v.id)).toEqual([sku(3)]);
  });

  it('does nothing without the index or in mock mode', async () => {
    expect(await reindexProducts(live(null).env)).toEqual({ skipped: true });
    const { stub } = index();
    expect(await reindexProducts(mock(live(null, stub).env))).toEqual({
      skipped: true,
    });
    expect(await reindexProducts(env)).toEqual({ skipped: true });
  });
});
