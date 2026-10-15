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

describe('0030_stripe_payments', () => {
  it('marks existing payments as mock and gives each Stripe customer to one account', async () => {
    const db = testEnv.MIGRATION_DB;
    const { applied, next } = before('0030_');
    await applyD1Migrations(db, applied);
    await db.batch([
      db.prepare(
        `INSERT INTO payments (id, order_id, kind, amount, status, ref, created_at) VALUES
         ('pay-old', 'o-old', 'authorization:card', 12.5, 'captured', 'cap-old', 0)`,
      ),
      db.prepare(
        `INSERT INTO customers (id, name, email) VALUES
         ('cus-a', 'A', 'a@example.com'), ('cus-b', 'B', 'b@example.com')`,
      ),
    ]);
    await applyD1Migrations(db, [next]);

    expect(
      await db
        .prepare(
          "SELECT provider, external_id, currency, amount FROM payments WHERE id = 'pay-old'",
        )
        .first(),
    ).toEqual({ provider: 'mock', external_id: null, currency: null, amount: 12.5 });
    expect(
      await db
        .prepare(
          "SELECT stripe_customer_id, stripe_payment_method_id FROM customers WHERE id = 'cus-a'",
        )
        .first(),
    ).toEqual({ stripe_customer_id: null, stripe_payment_method_id: null });
    await db.prepare("UPDATE customers SET stripe_customer_id = 'cus_X' WHERE id = 'cus-a'").run();
    await expect(
      db.prepare("UPDATE customers SET stripe_customer_id = 'cus_X' WHERE id = 'cus-b'").run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe('0031_invoices_payment_events', () => {
  it('adds the invoice and event tables beside existing rows, one row per Stripe invoice', async () => {
    const db = testEnv.MIGRATION_DB;
    const { applied, next } = before('0031_');
    await applyD1Migrations(db, applied);
    await db.batch([
      db.prepare(
        `INSERT INTO payments (id, order_id, kind, amount, status, created_at, provider, external_id, currency)
         VALUES ('pay-s', 'o-1', 'authorization:card', 10, 'authorized', 0, 'stripe', 'pi_1', 'USD')`,
      ),
      db.prepare(
        `INSERT INTO balance_entries (id, order_id, customer_id, amount, applied, created_at)
         VALUES ('bal_o-1', 'o-1', 'cus-a', 10, 1, 0)`,
      ),
    ]);
    await applyD1Migrations(db, [next]);

    expect(
      await db.prepare("SELECT provider, external_id FROM payments WHERE id = 'pay-s'").first(),
    ).toEqual({ provider: 'stripe', external_id: 'pi_1' });
    expect(
      await db.prepare("SELECT amount, applied FROM balance_entries WHERE id = 'bal_o-1'").first(),
    ).toEqual({ amount: 10, applied: 1 });
    const invoice = (id: string, external: string | null) =>
      db
        .prepare(
          `INSERT INTO invoices (id, order_id, provider, status, external_id, amount, currency, terms, balance_entry_id, created_at)
           VALUES (?, 'o-1', 'stripe', 'pending', ?, 10, 'USD', 'net_30', 'bal_o-1', 0)`,
        )
        .bind(id, external)
        .run();
    await invoice('inv-a', 'in_1');
    await invoice('inv-b', null);
    await invoice('inv-c', null);
    await expect(invoice('inv-d', 'in_1')).rejects.toThrow(/UNIQUE/);
    expect(
      await db
        .prepare("SELECT status, paid_at, hosted_url FROM invoices WHERE id = 'inv-a'")
        .first(),
    ).toEqual({ status: 'pending', paid_at: null, hosted_url: null });
    const event = (receivedAt: number) =>
      db
        .prepare(
          "INSERT INTO payment_events (id, provider, type, received_at) VALUES ('evt_1', 'stripe', 'invoice.paid', ?)",
        )
        .bind(receivedAt)
        .run();
    await event(0);
    await expect(event(1)).rejects.toThrow(/UNIQUE|PRIMARY/);
  });
});
