import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { describe, expect, it } from 'vitest';

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  TEST_SEED: D1Migration[];
  TEST_DEMO_RESET: D1Migration[];
  DEMO_DB: D1Database;
};

/** Runs SQL files the way `wrangler d1 execute --file` does: every statement, in one batch. */
const run = (db: D1Database, files: D1Migration[]) =>
  db.batch(files.flatMap((f) => f.queries.map((q) => db.prepare(q))));

const count = async (db: D1Database, sql: string) =>
  (await db.prepare(`SELECT count(*) AS n FROM ${sql}`).first<{ n: number }>())!.n;

describe('the demo reset', () => {
  it('removes what visitors made, keeps the people and settings, and the demo data loads again', async () => {
    const db = testEnv.DEMO_DB;
    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
    await run(db, testEnv.TEST_SEED);
    const customers = await count(db, 'customers');
    const products = await count(db, 'products');

    await db.batch([
      db.prepare(
        `INSERT INTO flows (id, name, model, graph_json, published_version, created_at, updated_at)
         VALUES ('visitor-flow', 'Mine', 'b2b', '{}', 1, 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO flow_versions (flow_id, version, flow_json, published_at) VALUES ('visitor-flow', 1, '{}', 0)`,
      ),
      db.prepare(
        `INSERT INTO orders (id, model, channel, status, flow_id, flow_version, created_at, updated_at)
         VALUES ('ord_visitor', 'b2b', 'api', 'waiting', 'visitor-flow', 1, 0, 0)`,
      ),
      db.prepare(`UPDATE products SET stock = 0 WHERE sku = 'MON-27'`),
      db.prepare(
        `INSERT INTO customers (id, name, email) VALUES ('cus_visitor', 'Visitor', 'v@example.com')`,
      ),
      db.prepare(
        `INSERT INTO users (id, email, name, role, created_at) VALUES
         ('usr_demo', 'demo@orderloop.app', 'Demo visitor', 'operator', 0),
         ('usr_owner', 'owner@example.com', 'Owner', 'operator', 0)`,
      ),
      db.prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES
         ('h-demo', 'usr_demo', 0, 9999999999999), ('h-owner', 'usr_owner', 0, 9999999999999)`,
      ),
      db.prepare(`INSERT INTO audit_events (id, at, action) VALUES ('aud_1', 0, 'auth.sign_in')`),
    ]);

    await run(db, testEnv.TEST_DEMO_RESET);
    expect(await count(db, 'orders')).toBe(0);
    expect(await count(db, 'flows')).toBe(0);
    expect(await count(db, 'audit_events')).toBe(0);
    expect(await count(db, "customers WHERE id = 'cus_internal'")).toBe(1);
    expect(await count(db, "fx_rates WHERE currency = 'USD'")).toBe(1);
    expect(await count(db, 'price_sources')).toBeGreaterThan(0);
    expect(await count(db, 'users')).toBe(2);
    expect(await count(db, "sessions WHERE user_id = 'usr_owner'")).toBe(1);
    expect(await count(db, "sessions WHERE user_id = 'usr_demo'")).toBe(0);

    await run(db, testEnv.TEST_SEED);
    expect(await count(db, 'customers')).toBe(customers);
    expect(await count(db, 'products')).toBe(products);
    expect(await count(db, "products WHERE sku = 'MON-27' AND stock > 0")).toBe(1);
  });
});
