import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { loadDeployments, matrix, renderEngine, renderWeb, toDeployment } from './fleet.ts';

const base = (app: string) =>
  parse(readFileSync(join(import.meta.dirname, '..', 'apps', app, 'wrangler.jsonc'), 'utf8'));

const acme = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: 'd1-acme',
  jurisdiction: 'eu',
});

test('a customer gets its own domain, names and environment by default', () => {
  assert.equal(acme.domain, 'acme.orderloop.app');
  assert.equal(acme.suffix, '-acme');
  assert.equal(acme.environment, 'deploy-acme');
});

test('the engine config carries the deployment everywhere a name is account-wide', () => {
  const c = renderEngine(base('engine'), acme);
  assert.equal(c.name, 'orderloop-engine-acme');
  assert.deepEqual(
    c.workflows.map((w: { name: string }) => w.name),
    ['orderloop-order-acme', 'orderloop-replenish-acme'],
  );
  assert.equal(c.d1_databases[0].database_name, 'orderloop-acme');
  assert.equal(c.d1_databases[0].database_id, 'd1-acme');
  assert.deepEqual(c.r2_buckets[0], {
    binding: 'DOCS',
    bucket_name: 'orderloop-docs-acme',
    jurisdiction: 'eu',
  });
  assert.equal(c.vars.AI_GATEWAY_ID, 'orderloop-acme');
  assert.equal(c.workers_dev, false);
});

test('the web config binds its own engine, domain and rate-limit namespaces', () => {
  const c = renderWeb(base('web'), acme);
  assert.equal(c.name, 'orderloop-web-acme');
  assert.deepEqual(c.routes, [{ pattern: 'acme.orderloop.app', custom_domain: true }]);
  assert.equal(c.services[0].service, 'orderloop-engine-acme');
  assert.deepEqual(
    c.ratelimits.map((r: { namespace_id: string }) => r.namespace_id),
    ['2001', '2002', '2003', '2004', '2005'],
  );
  assert.equal(c.d1_databases[0].migrations_dir, '../../packages/db/migrations');
});

test("a customer's limits replace the base budgets they name", () => {
  const big = toDeployment({ ...acme, limits: { webhooks: 6000 } });
  const limit = (c: {
    ratelimits: { name: string; simple: { limit: number; period: number } }[];
  }) => Object.fromEntries(c.ratelimits.map((r) => [r.name, r.simple]));
  const c = limit(renderWeb(base('web'), big));
  assert.deepEqual(c.WEBHOOK_LIMIT, { limit: 6000, period: 60 });
  assert.deepEqual(c.API_LIMIT, limit(base('web')).API_LIMIT);
  assert.throws(() => toDeployment({ ...acme, limits: { mcp: 10 } }), /limits.mcp/);
  assert.throws(() => toDeployment({ ...acme, limits: { api: 0 } }), /positive/);
});

test("OrderLoop's own deployment renders the base configs unchanged", () => {
  const d = loadDeployments().find((x) => x.id === 'orderloop')!;
  assert.deepEqual(renderEngine(base('engine'), d), base('engine'));
  assert.deepEqual(renderWeb(base('web'), d), base('web'));
});

test('bad entries are refused', () => {
  assert.throws(() => toDeployment({ id: 'Acme', ring: 'canary', slot: 2, d1Id: 'x' }), /id must/);
  assert.throws(() => toDeployment({ id: 'acme', ring: 'beta', slot: 2, d1Id: 'x' }), /ring/);
  assert.throws(() => toDeployment({ id: 'api', ring: 'general', slot: 2 }), /reserved/);
  // OrderLoop's own staging deployment may use the name, with its domain set.
  assert.equal(
    toDeployment({ id: 'staging', ring: 'staging', slot: 3, domain: 'staging.orderloop.app' }).id,
    'staging',
  );
  assert.throws(
    () => renderEngine(base('engine'), toDeployment({ id: 'acme', ring: 'canary', slot: 2 })),
    /provision/,
  );
});

test('an unprovisioned deployment blocks the matrix unless it is held', () => {
  const fresh = toDeployment({ id: 'new', ring: 'general', slot: 4 });
  assert.throws(() => matrix([acme, fresh]), /not provisioned/);
  assert.deepEqual(matrix([acme, { ...fresh, hold: true }]).general, []);
});

test('the matrix groups by ring and leaves held deployments out', () => {
  const held = toDeployment({ id: 'beta', ring: 'canary', slot: 3, d1Id: 'x', hold: true });
  const m = matrix([acme, held]);
  assert.deepEqual(
    m.canary.map((d) => d.id),
    ['acme'],
  );
  assert.deepEqual(m.general, []);
});

test('a demo mocks models, speeds up time and turns on demo sign-in', () => {
  const demo = toDeployment({
    id: 'demo',
    ring: 'internal',
    slot: 5,
    d1Id: 'd',
    domain: 'demo.orderloop.app',
    demo: true,
  });
  const engine = renderEngine(base('engine'), demo);
  assert.equal(engine.vars.AI_MODE, 'mock');
  assert.equal(engine.vars.AI_GATEWAY_ID, '');
  assert.equal(engine.vars.TIME_SCALE, '1440');
  assert.equal(renderWeb(base('web'), demo).vars.DEMO_MODE, 'true');
  assert.equal(renderWeb(base('web'), acme).vars.DEMO_MODE, '');
});
