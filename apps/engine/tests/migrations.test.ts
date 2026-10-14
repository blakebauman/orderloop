import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { describe, expect, it } from 'vitest';

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[]; MIGRATION_DB: D1Database };
const before = (name: string) => {
  const i = testEnv.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith(name));
  if (i < 0) throw new Error(`No migration ${name}`);
  return { applied: testEnv.TEST_MIGRATIONS.slice(0, i), next: testEnv.TEST_MIGRATIONS[i]! };
};

describe('0018_order_models', () => {
  it('moves flows, published versions, orders and node runs to a model and a channel', async () => {
    const db = testEnv.MIGRATION_DB;
    const { applied, next } = before('0018_');
    await applyD1Migrations(db, applied);
    const flow = (id: string, orderType: string) =>
      JSON.stringify({ id, name: id, description: '', orderType, nodes: [], edges: [] });
    await db.batch([
      db.prepare(
        `INSERT INTO flows (id, name, order_type, graph_json, published_version, created_at, updated_at)
         VALUES ('f-b2b', 'B2B', 'b2b_order', '{}', 1, 0, 0), ('f-shop', 'Shop', 'storefront_order', '{}', 1, 0, 0)`,
      ),
      db
        .prepare(
          `INSERT INTO flow_versions (flow_id, version, flow_json, published_at) VALUES ('f-b2b', 1, ?, 0), ('f-shop', 1, ?, 0)`,
        )
        .bind(flow('f-b2b', 'b2b_order'), flow('f-shop', 'storefront_order')),
      db.prepare(
        `INSERT INTO orders (id, type, status, flow_id, flow_version, created_at, updated_at, idempotency_key) VALUES
         ('o-email', 'b2b_order', 'completed', 'f-b2b', 1, 0, 0, 'email:<m1@x>'),
         ('o-shop', 'storefront_order', 'completed', 'f-shop', 1, 0, 0, NULL),
         ('o-reorder', 'reorder', 'completed', 'f-b2b', 1, 0, 0, NULL),
         ('o-buy', 'purchase_request', 'completed', 'f-b2b', 1, 0, 0, NULL),
         ('o-api', 'b2b_order', 'completed', 'f-b2b', 1, 0, 0, 'po-1')`,
      ),
      db.prepare(
        `INSERT INTO node_runs (order_id, generation, node_id, run, node_type, order_type, status, started_at, ended_at, duration_ms)
         VALUES ('o-shop', 1, 'pay', 1, 'commerce.authorize_payment', 'storefront_order', 'succeeded', 0, 1, 1)`,
      ),
    ]);
    await applyD1Migrations(db, [next]);

    const flows = await db.prepare('SELECT id, model, channels FROM flows ORDER BY id').all();
    expect(flows.results).toEqual([
      { id: 'f-b2b', model: 'b2b', channels: '["email","api","manual"]' },
      { id: 'f-shop', model: 'b2c', channels: '["web","mobile","api"]' },
    ]);
    const versions = await db
      .prepare('SELECT flow_json FROM flow_versions ORDER BY flow_id')
      .all<{ flow_json: string }>();
    expect(versions.results.map((r) => JSON.parse(r.flow_json))).toEqual([
      expect.objectContaining({ model: 'b2b', channels: ['email', 'api', 'manual'] }),
      expect.objectContaining({ model: 'b2c', channels: ['web', 'mobile', 'api'] }),
    ]);
    expect(versions.results.some((r) => r.flow_json.includes('orderType'))).toBe(false);
    const orders = await db.prepare('SELECT id, model, channel FROM orders ORDER BY id').all();
    expect(orders.results).toEqual([
      { id: 'o-api', model: 'b2b', channel: 'api' },
      { id: 'o-buy', model: 'procurement', channel: 'manual' },
      { id: 'o-email', model: 'b2b', channel: 'email' },
      { id: 'o-reorder', model: 'replenishment', channel: 'schedule' },
      { id: 'o-shop', model: 'b2c', channel: 'web' },
    ]);
    const run = await db.prepare('SELECT model FROM node_runs').first();
    expect(run).toEqual({ model: 'b2c' });
    const kinds = await db.prepare('SELECT id, kind FROM customers ORDER BY id').all();
    expect(kinds.results).toEqual(
      expect.arrayContaining([
        { id: 'cus_ada', kind: 'consumer' },
        { id: 'cus_internal', kind: 'internal' },
        { id: 'cus_northwind', kind: 'business' },
      ]),
    );
  });
});

describe('0027_remove_demo_data', () => {
  it('removes the demo catalog and the orders placed against it, keeping the rest', async () => {
    const db = testEnv.MIGRATION_DB;
    const { applied, next } = before('0027_');
    await applyD1Migrations(db, applied);
    await db.batch([
      db.prepare(
        `INSERT INTO orders (id, model, channel, status, title, flow_id, flow_version, customer_id, currency, total, generation, created_at, updated_at) VALUES
         ('o-demo', 'b2b', 'manual', 'completed', '', 'f', 1, 'cus_northwind', 'USD', 10, 1, 0, 0),
         ('o-reorder-demo', 'replenishment', 'schedule', 'completed', '', 'f', 1, 'cus_internal', 'USD', 0, 1, 0, 0),
         ('o-guest-demo', 'b2c', 'web', 'cancelled', '', 'f', 1, NULL, 'USD', 0, 1, 0, 0),
         ('o-real', 'b2b', 'api', 'completed', '', 'f', 1, NULL, 'USD', 5, 1, 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO reservations (id, order_id, sku, qty, status, created_at) VALUES
         ('r-demo', 'o-guest-demo', 'MON-27', 1, 'released', 0)`,
      ),
      db.prepare(
        `INSERT INTO balance_entries (id, order_id, customer_id, amount, applied, created_at) VALUES
         ('b-demo', 'o-demo', 'cus_northwind', 10, 1, 0)`,
      ),
      db.prepare(
        `INSERT INTO node_runs (order_id, generation, node_id, run, node_type, model, status, started_at, ended_at, duration_ms)
         VALUES ('o-demo', 1, 'start', 1, 'trigger.manual', 'b2b', 'succeeded', 0, 1, 1)`,
      ),
    ]);
    await applyD1Migrations(db, [next]);

    const ids = async (sql: string) =>
      (await db.prepare(sql).all<{ id: string }>()).results.map((r) => r.id);
    expect(await ids("SELECT id FROM orders WHERE id LIKE 'o-%demo' OR id = 'o-real'")).toEqual([
      'o-real',
    ]);
    expect(await ids('SELECT id FROM customers')).toEqual(['cus_internal']);
    expect(await ids("SELECT node_id AS id FROM node_runs WHERE order_id = 'o-demo'")).toEqual([]);
    expect(await ids('SELECT sku AS id FROM products')).toEqual([]);
    expect(await ids('SELECT currency AS id FROM fx_rates')).toEqual(['USD']);
    expect((await ids('SELECT id FROM price_sources ORDER BY id')).length).toBe(3);
    for (const table of ['reservations', 'balance_entries', 'sellers', 'locations'])
      expect(
        (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n,
      ).toBe(0);
  });
});
