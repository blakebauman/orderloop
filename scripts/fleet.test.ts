import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import {
  keysProblem,
  loadDeployments,
  matrix,
  missingPluginSecrets,
  names,
  pluginBinding,
  pluginKey,
  pluginOwnSecrets,
  RESERVED_PATH_SEGMENTS,
  renderCatalog,
  renderCatalogEdge,
  renderEngine,
  renderPlugin,
  renderWeb,
  sandboxedPlugins,
  secretsProblem,
  toDeployment,
  workerPlugins,
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
  assert.equal(c.vars.AI_GATEWAY_LOGS, 'false');
  assert.equal(
    renderEngine(base('engine'), { ...acme, aiGatewayLogs: true }).vars.AI_GATEWAY_LOGS,
    'true',
  );
  assert.deepEqual(c.vectorize, [
    { binding: 'PRODUCT_VECTORS', index_name: 'orderloop-products-acme' },
  ]);
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
  assert.deepEqual(
    c.queues.consumers.map((q: { queue: string }) => q.queue),
    [
      'orderloop-catalog-feed-parts-acme',
      'orderloop-catalog-changes-acme',
      'orderloop-catalog-feed-parts-dlq-acme',
      'orderloop-catalog-changes-dlq-acme',
      'orderloop-catalog-purge-dlq-acme',
    ],
  );
  assert.ok(
    c.queues.producers.some((p: { queue: string }) => p.queue === 'orderloop-catalog-changes-acme'),
  );
  assert.equal(c.vars.DATA_JURISDICTION, 'eu');
  assert.equal(c.workers_dev, false);
  // It writes variant names and prices into the deployment's own D1.
  assert.deepEqual(c.d1_databases, [
    { binding: 'DB', database_name: 'orderloop-acme', database_id: 'd1-acme' },
  ]);
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
  // Search goes to this deployment's own catalog.
  assert.deepEqual(c.services, [
    { binding: 'CATALOG', service: 'orderloop-catalog-acme', entrypoint: 'SearchApi' },
  ]);
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

test("the catalog consumes every dead-letter queue, its own and catalog-edge's, by the deployment's names", () => {
  type Consumer = { queue: string; dead_letter_queue?: string; retry_delay?: number };
  const catalog: Consumer[] = renderCatalog(base('catalog'), acme).queues.consumers;
  const edge: Consumer[] = renderCatalogEdge(base('catalog-edge'), acme).queues.consumers;
  const dlqs = [...catalog, ...edge].flatMap((c) => c.dead_letter_queue ?? []);
  const n = names(acme);
  assert.deepEqual(
    dlqs.sort(),
    [n.catalogChangesDlq, n.catalogFeedPartsDlq, n.catalogPurgeDlq].sort(),
  );
  const consumed = new Set(catalog.map((c) => c.queue));
  for (const q of dlqs) assert.ok(consumed.has(q), `${q} has no consumer`);
  // A dead-letter queue's consumer has no dead-letter queue of its own.
  for (const c of catalog.filter((c) => dlqs.includes(c.queue)))
    assert.equal(c.dead_letter_queue, undefined);
  // Every consumer delays a retry after a thrown invocation instead of redelivering at once.
  for (const c of [...catalog, ...edge])
    assert.ok((c.retry_delay ?? 0) > 0, `${c.queue} retry_delay`);
});

test('the web config binds its own engine, domain and rate-limit namespaces', () => {
  const c = renderWeb(base('web'), acme);
  assert.equal(c.name, 'orderloop-web-acme');
  assert.deepEqual(c.routes, [{ pattern: 'acme.orderloop.app', custom_domain: true }]);
  assert.equal(c.services[0].service, 'orderloop-engine-acme');
  assert.equal(c.services[1].service, 'orderloop-catalog-acme');
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
  // Its punchout cancels the POs a buyer calls off: the grant ships in the same engine deploy as
  // the check, and the pinned bundle whose manifest asks for it.
  assert.deepEqual(JSON.parse(base('engine').vars.PLUGIN_GRANTS).punchout.capabilities, [
    'carts:external',
    'orders:start',
    'orders:cancel',
  ]);
});

// A deployment's Durable Objects take their classes and migrations from the base config alone:
// scripts/do-migrations.test.ts guards those, and a render that touched them would skip the guard.
test('rendering never changes Durable Object bindings or migrations', () => {
  const demo = toDeployment({ ...acme, id: 'acme-demo', demo: true });
  for (const d of [...loadDeployments().filter((x) => x.d1Id && x.catalogKvId), acme, demo]) {
    for (const [app, render] of [
      ['engine', renderEngine],
      ['catalog', renderCatalog],
    ] as const) {
      const c = render(base(app), d);
      assert.deepEqual(c.migrations, base(app).migrations, `${d.id}: ${app} migrations`);
      assert.deepEqual(c.durable_objects, base(app).durable_objects, `${d.id}: ${app} bindings`);
    }
    for (const [app, render] of [
      ['web', renderWeb],
      ['catalog-edge', renderCatalogEdge],
    ] as const) {
      const c = render(base(app), d);
      assert.equal(c.migrations, undefined, `${d.id}: ${app} migrations`);
      assert.equal(c.durable_objects, undefined, `${d.id}: ${app} bindings`);
    }
  }
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
  // No model calls, so no product index to provision or bind.
  assert.equal(engine.vectorize, undefined);
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
  assert.equal(toDeployment(acme).aiGatewayLogs, false);
  assert.equal(toDeployment({ ...acme, aiGatewayLogs: true }).aiGatewayLogs, true);
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
  // An email without email_verified is trusted only when the registry says so (Entra ID).
  assert.equal(c.vars.OIDC_TRUST_EMAIL, '');
  const entra = toDeployment({
    ...acme,
    sso: { issuer: 'https://login.microsoftonline.com/t/v2.0', clientId: 'app', trustEmail: true },
  });
  assert.equal(renderWeb(base('web'), entra).vars.OIDC_TRUST_EMAIL, 'true');
  assert.throws(
    () =>
      toDeployment({
        ...acme,
        sso: { issuer: 'https://acme.okta.com', clientId: 'x', trustEmail: 'yes' },
      }),
    /trustEmail/,
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

const withLedger = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: 'd1-acme',
  catalogKvId: 'a'.repeat(32),
  plugins: { ledger: { d1Id: 'd1-ledger' } },
});

test('no plugins changes nothing in the engine and web configs', () => {
  const none = toDeployment({ id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1-acme' });
  assert.deepEqual(none.plugins, {});
  assert.deepEqual(renderEngine(base('engine'), none).services, base('engine').services);
  const bindings = (c: { services: { binding: string }[] }) => c.services.map((s) => s.binding);
  assert.deepEqual(bindings(renderWeb(base('web'), none)), bindings(base('web')));
});

test('a plugin is bound to the engine and the web Worker by its own Worker name', () => {
  const binding = { binding: 'PLUGIN_LEDGER', service: 'orderloop-plugin-ledger-acme' };
  assert.deepEqual(renderEngine(base('engine'), withLedger).services.at(-1), binding);
  assert.deepEqual(renderWeb(base('web'), withLedger).services.at(-1), binding);
});

test('a plugin config gets its own name and database', () => {
  const pluginBase = { name: 'orderloop-plugin-ledger', d1_databases: [{ binding: 'DB' }] };
  const c = renderPlugin(pluginBase, withLedger, 'ledger');
  assert.equal(c.name, 'orderloop-plugin-ledger-acme');
  assert.deepEqual(c.d1_databases[0], {
    binding: 'DB',
    database_name: 'orderloop-plugin-ledger-acme',
    database_id: 'd1-ledger',
  });
  assert.throws(
    () => renderPlugin(pluginBase, { ...withLedger, plugins: { ledger: {} } }, 'ledger'),
    /no d1Id/,
  );
});

test('plugins are checked: ids, fixtures and provisioning', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  assert.throws(() => toDeployment({ ...raw, plugins: ['ledger'] }), /plugins must be an object/);
  assert.throws(() => toDeployment({ ...raw, plugins: { Bad_Id: {} } }), /not a plugin id/);
  assert.throws(() => toDeployment({ ...raw, plugins: { example: {} } }), /test fixture/);
  assert.throws(
    () => matrix([toDeployment({ ...raw, plugins: { ledger: {} } })]),
    /not provisioned/,
  );
  assert.equal(pluginBinding('qbd-sync'), 'PLUGIN_QBD_SYNC');
});

test('a plugin may declare only its database and vars, and gets one D1 binding', () => {
  const base = { name: 'orderloop-plugin-ledger', main: 'src/index.ts', vars: { A: '1' } };
  for (const key of [
    'services',
    'durable_objects',
    'r2_buckets',
    'kv_namespaces',
    'queues',
    'routes',
  ])
    assert.throws(
      () => renderPlugin({ ...base, [key]: [] }, withLedger, 'ledger'),
      new RegExp(`may not declare ${key}`),
    );
  assert.throws(
    () =>
      renderPlugin(
        { ...base, d1_databases: [{ binding: 'DB' }, { binding: 'OTHER' }] },
        withLedger,
        'ledger',
      ),
    /one D1 binding, named DB/,
  );
  assert.throws(
    () => renderPlugin({ ...base, d1_databases: [{ binding: 'CORE' }] }, withLedger, 'ledger'),
    /named DB/,
  );
  assert.deepEqual(renderPlugin(base, withLedger, 'ledger').vars, { A: '1' });
});

test('a plugin gets only its own PLUGIN_<ID>_* secrets, under their own names', () => {
  const source = {
    PRINCIPAL_KEY: 'p',
    STRIPE_SECRET_KEY: 'sk',
    PLUGIN_SHIPSTATION_API_KEY: 'k1',
    PLUGIN_SHIPSTATION_API_SECRET: 's1',
    PLUGIN_SHIPSTATION_UNSET: '',
    PLUGIN_LEDGER_API_KEY: 'k2',
  };
  assert.deepEqual(pluginOwnSecrets('shipstation', source), { API_KEY: 'k1', API_SECRET: 's1' });
  assert.deepEqual(pluginOwnSecrets('qbd-sync', { PLUGIN_QBD_SYNC_TOKEN: 't' }), { TOKEN: 't' });
  assert.throws(
    () => pluginOwnSecrets('ledger', { PLUGIN_LEDGER_PLUGIN_KEY: 'x' }),
    /can't be a secret name/,
  );
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  assert.throws(
    () => toDeployment({ ...raw, plugins: { ship: {}, 'ship-rates': {} } }),
    /can't both be installed/,
  );
});

test("a plugin's key is derived from the principal key, as core derives it", () => {
  // The same vector as packages/core/tests/plugins.test.ts.
  assert.equal(
    pluginKey('test-principal-key', 'example'),
    '3b9f2f08046e6b872940790364b2e8be0fb31ec677270a2464f10a29e9fcae13',
  );
  assert.notEqual(
    pluginKey('test-principal-key', 'ledger'),
    pluginKey('test-principal-key', 'example'),
  );
});

test('buyer details are granted to a plugin only by its registry entry', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  const granted = toDeployment({
    ...raw,
    plugins: { ledger: { d1Id: 'x', personalData: 'send' }, qbd: { d1Id: 'y' } },
  });
  assert.equal(
    renderEngine(base('engine'), granted).vars.PLUGIN_GRANTS,
    '{"ledger":{"personalData":"send"}}',
  );
  assert.equal(renderEngine(base('engine'), withLedger).vars.PLUGIN_GRANTS, '');
  assert.throws(
    () => toDeployment({ ...raw, plugins: { ledger: { personalData: 'yes' } } }),
    /can only be "send"/,
  );
  assert.throws(
    () => toDeployment({ ...raw, plugins: { ledger: { events: ['*'] } } }),
    /unknown keys: events/,
  );
});

test('capabilities are granted by the registry, and bind the host API as the plugin itself', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  const d = toDeployment({
    ...raw,
    plugins: {
      punchout: { d1Id: 'x', capabilities: ['carts:external', 'orders:start', 'orders:cancel'] },
      qbd: { d1Id: 'y' },
    },
  });
  assert.equal(
    renderEngine(base('engine'), d).vars.PLUGIN_GRANTS,
    '{"punchout":{"capabilities":["carts:external","orders:start","orders:cancel"]}}',
  );
  // Cancelling is its own grant: starting orders doesn't bring it.
  assert.equal(
    renderEngine(
      base('engine'),
      toDeployment({
        ...raw,
        plugins: { punchout: { d1Id: 'x', capabilities: ['orders:start'] } },
      }),
    ).vars.PLUGIN_GRANTS,
    '{"punchout":{"capabilities":["orders:start"]}}',
  );
  const pluginBase = { name: 'x', main: 'src/index.ts', d1_databases: [{ binding: 'DB' }] };
  assert.deepEqual(renderPlugin(pluginBase, d, 'punchout').services, [
    {
      binding: 'ORDERLOOP',
      service: renderEngine(base('engine'), d).name,
      entrypoint: 'PluginHost',
      props: { id: 'punchout' },
    },
  ]);
  const vars = renderEngine(base('engine'), d).vars;
  assert.equal(vars.APP_ORIGIN, 'https://acme.orderloop.app');
  assert.equal(vars.OWN_HOSTS, 'acme.orderloop.app,catalog.acme.orderloop.app');
  // No capability, no host binding.
  assert.equal(renderPlugin(pluginBase, d, 'qbd').services, undefined);
  assert.throws(
    () => toDeployment({ ...raw, plugins: { punchout: { capabilities: ['orders:delete'] } } }),
    /capabilities must list/,
  );
  assert.throws(
    () =>
      toDeployment({
        ...raw,
        plugins: { punchout: { capabilities: ['orders:start', 'orders:start'] } },
      }),
    /at most once/,
  );
});

const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
const STORE = '0123456789abcdef0123456789abcdef';

test('a sandboxed plugin has no Worker, binding or database of its own', () => {
  const d = toDeployment({
    ...raw,
    plugins: { ledger: { d1Id: 'd1-ledger' }, carrier: { runtime: 'sandboxed' } },
  });
  assert.deepEqual(workerPlugins(d), ['ledger']);
  assert.deepEqual(sandboxedPlugins(d), ['carrier']);
  const bindings = (c: { services?: { binding: string }[] }) =>
    (c.services ?? []).map((s) => s.binding).filter((b) => b.startsWith('PLUGIN_'));
  assert.deepEqual(bindings(renderEngine(base('engine'), d)), ['PLUGIN_LEDGER']);
  assert.deepEqual(bindings(renderWeb(base('web'), d)), ['PLUGIN_LEDGER']);
  assert.throws(() => renderPlugin({}, d, 'carrier'), /sandboxed: no Worker/);
  // Needs no d1Id to deploy.
  assert.doesNotThrow(() => matrix([d]));
  assert.throws(
    () => toDeployment({ ...raw, plugins: { carrier: { runtime: 'sandboxed', d1Id: 'x' } } }),
    /sandboxed: it has no D1 database/,
  );
  assert.throws(() => toDeployment({ ...raw, plugins: { carrier: { runtime: 'vm' } } }), /runtime/);
});

test('plugin ids are refused when reserved or with a double dash', () => {
  for (const id of ['bundles', 'secrets', 'grants', 'key', 'publishers'])
    assert.throws(() => toDeployment({ ...raw, plugins: { [id]: {} } }), /reserved/);
  assert.throws(() => toDeployment({ ...raw, plugins: { 'a--b': {} } }), /not a plugin id/);
  assert.throws(() => toDeployment({ ...raw, plugins: { 'ab-': {} } }), /not a plugin id/);
});

test('on its own account, plugin secrets are bound from the Secrets Store', () => {
  const d = toDeployment({
    ...raw,
    secretsStore: { storeId: STORE },
    plugins: {
      ledger: { d1Id: 'd1-ledger', secrets: ['API_KEY'] },
      carrier: { runtime: 'sandboxed', secrets: ['API_KEY', 'HOOK'] },
    },
  });
  assert.deepEqual(renderEngine(base('engine'), d).secrets_store_secrets, [
    {
      binding: 'PLUGIN_SECRET_CARRIER__API_KEY',
      store_id: STORE,
      secret_name: 'PLUGIN_CARRIER_API_KEY',
    },
    { binding: 'PLUGIN_SECRET_CARRIER__HOOK', store_id: STORE, secret_name: 'PLUGIN_CARRIER_HOOK' },
  ]);
  const plugin = renderPlugin({ name: 'x', d1_databases: [{ binding: 'DB' }] }, d, 'ledger');
  assert.deepEqual(plugin.secrets_store_secrets, [
    { binding: 'API_KEY', store_id: STORE, secret_name: 'PLUGIN_LEDGER_API_KEY' },
  ]);
  assert.throws(() => toDeployment({ ...raw, secretsStore: { storeId: 'nope' } }), /secretsStore/);
  assert.throws(
    () => toDeployment({ ...raw, plugins: { carrier: { secrets: ['lower'] } } }),
    /secret names/,
  );
});

test('a shared account binds no Secrets Store', () => {
  const d = toDeployment({ ...raw, plugins: { carrier: { runtime: 'sandboxed' } } });
  assert.equal(renderEngine(base('engine'), d).secrets_store_secrets, undefined);
});

test('the deploy finds a plugin’s missing secrets, by name only', () => {
  const shared = toDeployment({ ...raw, plugins: { carrier: { runtime: 'sandboxed' } } });
  assert.deepEqual(
    missingPluginSecrets(shared, 'carrier', ['API_KEY', 'HOOK'], {
      env: { PLUGIN_CARRIER_API_KEY: 'k', PLUGIN_CARRIER_HOOK: '' },
    }),
    ['HOOK'],
  );
  const own = toDeployment({
    ...raw,
    secretsStore: { storeId: STORE },
    plugins: { carrier: { runtime: 'sandboxed', secrets: ['API_KEY'] } },
  });
  assert.deepEqual(
    missingPluginSecrets(own, 'carrier', ['API_KEY', 'HOOK'], {
      stored: ['PLUGIN_CARRIER_API_KEY', 'PLUGIN_CARRIER_HOOK'],
    }),
    // HOOK is in the store but not listed in the registry, so nothing binds it.
    ['HOOK'],
  );
  assert.deepEqual(missingPluginSecrets(own, 'carrier', ['API_KEY'], { stored: [] }), ['API_KEY']);
});

test('runtime installs are off unless the registry lists publishers', () => {
  const key = 'gzGcgrEQxp3cOiLXbe8UXlTefRdy8Xrf_p9OxPz7dNI';
  const on = toDeployment({ ...raw, pluginInstalls: { publishers: { acme: key } } });
  assert.equal(renderEngine(base('engine'), on).vars.PLUGIN_PUBLISHERS, `{"acme":"${key}"}`);
  assert.equal(renderEngine(base('engine'), toDeployment(raw)).vars.PLUGIN_PUBLISHERS, undefined);
  // Not the base config's (orderloop.app's) "on": only a registry that asks for it.
  assert.equal(base('engine').vars.ASSISTANT_PLUGINS, 'on');
  assert.equal(renderEngine(base('engine'), on).vars.ASSISTANT_PLUGINS, undefined);
  assert.equal(renderEngine(base('engine'), toDeployment(raw)).vars.ASSISTANT_PLUGINS, undefined);
  const drafts = toDeployment({ ...raw, pluginInstalls: { assistant: true } });
  assert.equal(renderEngine(base('engine'), drafts).vars.ASSISTANT_PLUGINS, 'on');
  assert.equal(renderEngine(base('engine'), drafts).vars.PLUGIN_PUBLISHERS, undefined);
  for (const bad of [
    {},
    { publishers: {} },
    { publishers: { Acme: key } },
    { publishers: { acme: 'short' } },
    { publishers: { assistant: key } },
    { publishers: { acme: key }, extra: true },
    { assistant: 'yes' },
  ])
    assert.throws(() => toDeployment({ ...raw, pluginInstalls: bad }), /pluginInstalls/);
});

test('the publisher tool signs what core verifies', async () => {
  const { keygen, signBundle, signingMessage } = await import('./plugin-pack.ts');
  const { publicKey, privatePem } = keygen();
  const file = signBundle(
    { body: '{}', sha: 'a'.repeat(64), manifest: { id: 'carrier', version: '2' } },
    'acme',
    privatePem,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(publicKey, 'base64url'),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    Buffer.from(file.signature, 'base64url'),
    new TextEncoder().encode(signingMessage('carrier', '2', 'a'.repeat(64))),
  );
  assert.equal(ok, true);
  assert.equal(signingMessage('a', 'b', 'c'), 'orderloop-plugin:1:a:b:c');
});

test('a plugin alias is one free path segment, rendered into the web Worker', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  const d = toDeployment({
    ...raw,
    plugins: { punchout: { alias: '/punchout/', runtime: 'sandboxed' } },
  });
  assert.equal(renderWeb(base('web'), d).vars.PLUGIN_ALIASES, '{"/punchout/":"punchout"}');
  // None: empty, so the base config's never carries over.
  const none = toDeployment({ ...raw, plugins: { punchout: { runtime: 'sandboxed' } } });
  assert.equal(renderWeb(base('web'), none).vars.PLUGIN_ALIASES, '');
  const refused = (alias: unknown, more = {}) =>
    assert.throws(() =>
      toDeployment({ ...raw, plugins: { punchout: { alias, runtime: 'sandboxed' }, ...more } }),
    );
  for (const alias of ['punchout', '/Punchout/', '/a/', '/punch/out/', '/punchout', 7, '/../'])
    refused(alias);
  for (const reserved of ['/orders/', '/api/', '/plugins/', '/carts/', '/login/'])
    refused(reserved);
  assert.throws(
    () =>
      toDeployment({
        ...raw,
        plugins: {
          punchout: { alias: '/buy/', runtime: 'sandboxed' },
          ledger: { alias: '/buy/', runtime: 'sandboxed' },
        },
      }),
    /also/,
  );
});

test('the reserved path segments cover every top-level path the web app serves', () => {
  const routes = readFileSync(new URL('../apps/web/app/routes.ts', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../apps/web/workers/app.ts', import.meta.url), 'utf8');
  const segments = new Set<string>();
  for (const m of routes.matchAll(/route\('([a-z0-9-]+)/g)) segments.add(m[1]!);
  for (const m of worker.matchAll(/'\/([a-z0-9-]+)[/']/g)) segments.add(m[1]!);
  for (const s of ['ucp', 'scim', 'mcp', 'a2a', 'oauth']) segments.add(s); // via *_PATH constants
  const missing = [...segments].filter((s) => !RESERVED_PATH_SEGMENTS.has(s));
  assert.deepEqual(missing, []);
});

test('the deploy refuses a shared key too short to sign with', () => {
  const key = 'a'.repeat(64);
  assert.equal(keysProblem({ PRINCIPAL_KEY: key, DATA_KEY: key }), null);
  // The password pepper too, when it's set.
  assert.equal(keysProblem({ PRINCIPAL_KEY: key, DATA_KEY: key, PASSWORD_PEPPER: key }), null);
  assert.match(
    keysProblem({ PRINCIPAL_KEY: key, DATA_KEY: key, PASSWORD_PEPPER: 'short' }) ?? '',
    /^PASSWORD_PEPPER must be at least 32 characters/,
  );
  assert.match(
    keysProblem({ PRINCIPAL_KEY: 'short', DATA_KEY: key, DATA_KEY_PREVIOUS: 'x'.repeat(31) }) ?? '',
    /^PRINCIPAL_KEY, DATA_KEY_PREVIOUS must be at least 32 characters/,
  );
});
