import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import {
  loadDeployments,
  matrix,
  renderCatalog,
  renderCatalogEdge,
  renderEngine,
  renderWeb,
  secretsProblem,
  toDeployment,
} from './fleet.ts';

const base = (app: string) =>
  parse(readFileSync(join(import.meta.dirname, '..', 'apps', app, 'wrangler.jsonc'), 'utf8'));

const acme = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: 'd1-acme',
  catalogKvId: 'a'.repeat(32),
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

test('the catalog config has its own name, bucket, card namespace and jurisdiction', () => {
  const c = renderCatalog(base('catalog'), acme);
  assert.equal(c.name, 'orderloop-catalog-acme');
  assert.deepEqual(c.r2_buckets[0], {
    binding: 'PUBLISHED',
    bucket_name: 'orderloop-catalog-acme',
    jurisdiction: 'eu',
  });
  assert.deepEqual(c.kv_namespaces[0], { binding: 'CARDS', id: 'a'.repeat(32) });
  assert.deepEqual(
    c.workflows.map((w: { name: string }) => w.name),
    ['orderloop-catalog-feed-acme'],
  );
  assert.equal(c.queues.producers[0].queue, 'orderloop-catalog-feed-parts-acme');
  assert.equal(c.queues.consumers[0].queue, 'orderloop-catalog-feed-parts-acme');
  assert.equal(c.queues.consumers[0].dead_letter_queue, 'orderloop-catalog-feed-parts-dlq-acme');
  assert.equal(c.vars.DATA_JURISDICTION, 'eu');
  assert.equal(c.workers_dev, false);
});

test("catalog-edge serves catalog.<domain> from the deployment's bucket, cards and purge queue", () => {
  const c = renderCatalogEdge(base('catalog-edge'), acme);
  assert.equal(acme.catalogDomain, 'catalog.acme.orderloop.app');
  assert.equal(c.name, 'orderloop-catalog-edge-acme');
  assert.deepEqual(c.routes, [{ pattern: 'catalog.acme.orderloop.app', custom_domain: true }]);
  assert.deepEqual(c.r2_buckets[0], {
    binding: 'PUBLISHED',
    bucket_name: 'orderloop-catalog-acme',
    jurisdiction: 'eu',
  });
  assert.deepEqual(c.kv_namespaces[0], { binding: 'CARDS', id: 'a'.repeat(32) });
  assert.equal(c.queues.consumers[0].queue, 'orderloop-catalog-purge-acme');
  assert.equal(c.queues.consumers[0].dead_letter_queue, 'orderloop-catalog-purge-dlq-acme');
  assert.equal(c.queues.consumers[0].max_concurrency, 1);
  assert.equal(c.analytics_engine_datasets[0].dataset, 'orderloop_catalog_edge_acme');
  // The catalog sends to the same purge queue.
  const producers = renderCatalog(base('catalog'), acme).queues.producers;
  assert.ok(producers.some((p: { queue: string }) => p.queue === 'orderloop-catalog-purge-acme'));
  assert.equal(
    toDeployment({ id: 'beta', ring: 'canary', slot: 5, catalogDomain: 'products.b.example' })
      .catalogDomain,
    'products.b.example',
  );
  assert.throws(
    () => toDeployment({ id: 'beta', ring: 'canary', slot: 5, catalogDomain: 'x' }),
    /catalogDomain/,
  );
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

test("orderloop.app's own deployment renders the base configs unchanged", () => {
  const d = loadDeployments().find((x) => x.id === 'orderloop')!;
  assert.deepEqual(renderCatalog(base('catalog'), d), base('catalog'));
  assert.deepEqual(renderCatalogEdge(base('catalog-edge'), d), base('catalog-edge'));
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
  assert.throws(
    () => toDeployment({ id: 'acme', ring: 'canary', slot: 2, catalogKvId: 'orderloop-cards' }),
    /catalogKvId/,
  );
  assert.throws(
    () =>
      renderCatalog(
        base('catalog'),
        toDeployment({ id: 'acme', ring: 'canary', slot: 2, d1Id: 'x' }),
      ),
    /catalogKvId: run scripts\/provision.sh acme/,
  );
});

test('an unprovisioned deployment blocks the matrix unless it is held', () => {
  const fresh = toDeployment({ id: 'new', ring: 'general', slot: 4 });
  assert.throws(() => matrix([acme, fresh]), /not provisioned/);
  // D1 alone isn't enough: the catalog needs its card namespace too.
  assert.throws(() => matrix([acme, { ...fresh, d1Id: 'x' }]), /not provisioned/);
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
  assert.equal(engine.vars.SIMULATE_FAILURES, 'true');
  assert.equal(renderEngine(base('engine'), acme).vars.SIMULATE_FAILURES, '');
  assert.equal(renderWeb(base('web'), demo).vars.DEMO_MODE, 'true');
  assert.equal(renderWeb(base('web'), acme).vars.DEMO_MODE, '');
});

test("a customer's auditRetentionDays sets the engine's retention, at least 90 days", () => {
  const long = toDeployment({ ...acme, auditRetentionDays: 2555 });
  assert.equal(renderEngine(base('engine'), long).vars.AUDIT_RETENTION_DAYS, '2555');
  assert.equal(renderEngine(base('engine'), toDeployment(acme)).vars.AUDIT_RETENTION_DAYS, '400');
  assert.throws(() => toDeployment({ ...acme, auditRetentionDays: 30 }), /at least 90/);
  assert.throws(() => toDeployment({ ...acme, auditRetentionDays: '400' }), /auditRetentionDays/);
});

test('workflow AI nodes see personal data only where the registry says send', () => {
  assert.equal(renderEngine(base('engine'), toDeployment(acme)).vars.AI_PERSONAL_DATA, 'redact');
  const send = toDeployment({ ...acme, aiPersonalData: 'send' });
  assert.equal(renderEngine(base('engine'), send).vars.AI_PERSONAL_DATA, 'send');
  assert.throws(() => toDeployment({ ...acme, aiPersonalData: 'all' }), /aiPersonalData/);
  assert.equal(toDeployment(acme).aiGatewayLogs, true);
  assert.equal(toDeployment({ ...acme, aiGatewayLogs: false }).aiGatewayLogs, false);
});

test("a customer's personalDataRetentionDays sets the sweep's, at least 30 days", () => {
  const short = toDeployment({ ...acme, personalDataRetentionDays: 365 });
  assert.equal(renderEngine(base('engine'), short).vars.PERSONAL_DATA_RETENTION_DAYS, '365');
  assert.equal(
    renderEngine(base('engine'), toDeployment(acme)).vars.PERSONAL_DATA_RETENTION_DAYS,
    '',
  );
  assert.throws(() => toDeployment({ ...acme, personalDataRetentionDays: 7 }), /at least 30/);
  assert.throws(() => toDeployment({ ...acme, auditArchiveDays: 0 }), /auditArchiveDays/);
});

test("an EU customer's Durable Objects are in the EU, like their D1 and R2", () => {
  const eu = toDeployment({ ...acme, jurisdiction: 'eu' });
  const c = renderEngine(base('engine'), eu);
  assert.equal(c.vars.DATA_JURISDICTION, 'eu');
  assert.equal(c.r2_buckets[0].jurisdiction, 'eu');
  const anywhere = toDeployment({ ...acme, jurisdiction: undefined });
  assert.equal(renderEngine(base('engine'), anywhere).vars.DATA_JURISDICTION, '');
});

test("a customer's sso sets the web Worker's identity provider", () => {
  const sso = toDeployment({
    ...acme,
    sso: { issuer: 'https://acme.okta.com', clientId: '0oa123' },
  });
  const c = renderWeb(base('web'), sso);
  assert.equal(c.vars.OIDC_ISSUER, 'https://acme.okta.com');
  assert.equal(c.vars.OIDC_CLIENT_ID, '0oa123');
  assert.equal(renderWeb(base('web'), acme).vars.OIDC_ISSUER, '');
  assert.throws(
    () => toDeployment({ ...acme, sso: { issuer: 'http://acme.okta.com', clientId: 'x' } }),
    /https issuer/,
  );
  assert.throws(
    () => toDeployment({ ...acme, sso: { issuer: 'https://acme.okta.com' } }),
    /clientId/,
  );
});

test("a customer's assistantDailyTokens sets the assistant's budget", () => {
  const big = toDeployment({ ...acme, assistantDailyTokens: 0 });
  assert.equal(renderEngine(base('engine'), big).vars.ASSISTANT_DAILY_TOKENS, '0');
  assert.equal(renderEngine(base('engine'), acme).vars.ASSISTANT_DAILY_TOKENS, '1000000');
  assert.throws(() => toDeployment({ ...acme, assistantDailyTokens: -1 }), /assistantDailyTokens/);
});

test('payments are mocked unless the registry says stripe, with its publishable key', () => {
  const mocked = renderEngine(base('engine'), acme);
  assert.equal(mocked.vars.PAYMENTS_MODE, 'mock');
  assert.equal(mocked.vars.STRIPE_PUBLISHABLE_KEY, '');
  const live = toDeployment({
    ...acme,
    payments: 'stripe',
    stripePublishableKey: 'pk_live_abc123',
  });
  const engine = renderEngine(base('engine'), live);
  assert.equal(engine.vars.PAYMENTS_MODE, 'stripe');
  assert.equal(engine.vars.STRIPE_PUBLISHABLE_KEY, 'pk_live_abc123');
  assert.throws(() => toDeployment({ ...acme, payments: 'paypal' }), /payments must/);
  assert.throws(
    () => toDeployment({ ...acme, payments: 'stripe', stripePublishableKey: 'sk_live_abc' }),
    /publishable key/,
  );
  assert.throws(
    () => toDeployment({ ...acme, stripePublishableKey: 'pk_test_abc' }),
    /needs payments/,
  );
  assert.throws(
    () => toDeployment({ id: 'demo', ring: 'internal', slot: 5, demo: true, payments: 'stripe' }),
    /demo/,
  );
});

test('a Stripe deployment needs STRIPE_SECRET_KEY in the same mode as its publishable key', () => {
  assert.equal(secretsProblem(acme, {}), null);
  const stripe = toDeployment({ ...acme, payments: 'stripe', stripePublishableKey: 'pk_test_abc' });
  assert.match(secretsProblem(stripe, {}) ?? '', /STRIPE_SECRET_KEY/);
  assert.match(
    secretsProblem(stripe, { STRIPE_SECRET_KEY: 'sk_live_x' }) ?? '',
    /both test or both live/,
  );
  assert.equal(secretsProblem(stripe, { STRIPE_SECRET_KEY: 'rk_test_x' }), null);
});
