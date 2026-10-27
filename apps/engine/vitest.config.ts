import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { buildSandboxBundle, bundlePlugin, sealBundle } from '@orderloop/plugin-sdk/testing';
import agents from 'agents/vite';
import { defineConfig } from 'vitest/config';

/**
 * The outside world a sandboxed plugin reaches through the engine's egress gateway, in the
 * `sandboxed` project: the carrier's live rates (naming the key it was sent by its last four
 * characters) and an allowed host that also redirects off its allowlist.
 */
async function carrierUpstream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === 'api.carrier.test' && url.pathname === '/echo')
    return Response.json({
      options: [{ id: 'echo', title: `sent ${request.headers.get('authorization')}`, amount: 8 }],
    });
  if (url.hostname === 'api.carrier.test' && url.pathname === '/rates') {
    const auth = request.headers.get('authorization') ?? '';
    return Response.json({
      options: [
        { id: 'live', title: `key ${auth.slice(-4) || 'none'}`, amount: 7, minDays: 1, maxDays: 3 },
      ],
    });
  }
  if (url.hostname.endsWith('allowed.test')) {
    if (url.pathname === '/redirect')
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    return new Response(`ok ${request.headers.get('authorization') ?? 'no auth'}`);
  }
  return new Response('unexpected upstream', { status: 599 });
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/migrations');
  // The demo customers, catalog and stores the tests order against (not part of the migrations).
  const seed = await readD1Migrations('../../packages/db/seed');
  // The demo deployment's nightly reset (.github/workflows/demo-reset.yml).
  const demoReset = await readD1Migrations('../../packages/db/reset');
  // A publisher for the runtime-install tests (as `pnpm plugin:pack keygen` makes one).
  const pair = generateKeyPairSync('ed25519');
  const publisher = {
    publicKey: pair.publicKey.export({ format: 'jwk' }).x as string,
    privateJwk: pair.privateKey.export({ format: 'jwk' }),
  };
  // The carrier as version 1, and a version 2 whose code answers with "2".
  const carrierV1 = await buildSandboxBundle(
    '../../plugins/fixture-carrier/src/index.ts',
    '../../plugins/fixture-carrier/migrations',
  );
  const v1 = JSON.parse(carrierV1.body) as { code: string; migrations: []; manifest: object };
  const carrierV2 = sealBundle({
    code: v1.code.replace('version: "1"', 'version: "2"'),
    migrations: v1.migrations,
    manifest: { ...v1.manifest, version: '2' } as never,
  });
  const installBundles = {
    v1: { body: carrierV1.body, sha: carrierV1.sha },
    v2: { body: carrierV2.body, sha: carrierV2.sha },
  };
  // The plugins as sandbox bundles (what CI's scripts/plugin-bundle.ts builds).
  const sandboxed = {
    example: await buildSandboxBundle(
      '../../plugins/example/src/index.ts',
      '../../plugins/example/migrations',
    ),
    'fixture-carrier': await buildSandboxBundle(
      '../../plugins/fixture-carrier/src/index.ts',
      '../../plugins/fixture-carrier/migrations',
    ),
  };
  // The punchout plugin, sandboxed, end to end with the host API (tests/punchout/).
  const punchout = {
    punchout: await buildSandboxBundle(
      '../../plugins/punchout/src/index.ts',
      '../../plugins/punchout/migrations',
    ),
  };

  /** One workerd project: the engine Worker with these extra bindings (and auxiliary Workers). */
  const project = (
    name: string,
    include: string[],
    bindings: Record<string, unknown> = {},
    plugins: Awaited<ReturnType<typeof bundlePlugin>>[] = [],
    extra: Record<string, unknown> = {},
  ) => ({
    plugins: [
      // TC39 decorators (`@callable()`): Oxc doesn't transform them yet.
      ...agents(),
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        // Workers AI stays unused: AI_MODE=mock routes every AI node to its heuristic.
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SEED: seed,
            TEST_DEMO_RESET: demoReset,
            AI_MODE: 'mock',
            TIME_SCALE: '1',
            // The failure-path tests set meta.simulate; tests/orders.test.ts also covers it off.
            SIMULATE_FAILURES: 'true',
            // Signs the principal header the tests send as the web Worker would (tests/principal.ts).
            PRINCIPAL_KEY: 'test-principal-key',
            // The app's origin and own hosts, for external carts' start links and returns.
            APP_ORIGIN: 'https://app.orderloop.test',
            OWN_HOSTS: 'app.orderloop.test,catalog.app.orderloop.test',
            // Encrypts secrets at rest (tests/secrets.test.ts rotates it).
            DATA_KEY: 'test-data-key',
            // Signs UCP order webhooks in tests (a throwaway key, never a deployment's).
            UCP_SIGNING_KEY: JSON.stringify({
              kty: 'EC',
              crv: 'P-256',
              x: '9BMdj1UdIkXENV6_5MJlSn_hc9o2M8ugpvUwJ_HjH5k',
              y: 'ydWDPKFRXLLygy6PsmbuGplP54RXbsePMjlM9Bswmu0',
              d: 'za01NtCYcTPRwZ-MHjrWj00mA1u3a_sBgjrBpu0SBfk',
              kid: 'test-ucp-2026',
            }),
            ...bindings,
          },
          // Empty databases: for migrations against rows in an older shape, the demo reset, and
          // an audit log no other test writes to.
          d1Databases: {
            MIGRATION_DB: 'migration-test',
            DEMO_DB: 'demo-test',
            AUDIT_DB: 'audit-test',
            // A catalog of thousands of SKUs for extraction, kept from the demo data others use.
            EXTRACT_DB: 'extract-test',
            // The plugins' own databases, so their tests can read what they wrote.
            ...(plugins.length
              ? { EXAMPLE_DB: 'plugin-example', CARRIER_DB: 'plugin-fixture-carrier' }
              : {}),
          },
          ...extra,
          ...(plugins.length ? { workers: plugins } : {}),
          serviceBindings: {
            // The catalog isn't run here: a stub stands in for the binding, which workerd needs
            // defined to start.
            CATALOG: () => new Response('no catalog in the engine tests', { status: 503 }),
            ...(plugins.length
              ? {
                  PLUGIN_EXAMPLE: 'orderloop-plugin-example',
                  PLUGIN_FIXTURE_CARRIER: 'orderloop-plugin-fixture-carrier',
                }
              : {}),
          },
        },
      }),
    ],
    test: {
      name,
      include,
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
    },
  });

  return {
    test: {
      projects: [
        // Payments in the default mock mode: `meta.simulate` drives declines. No plugins are
        // installed, as in a deployment that never added one or has removed one.
        project('engine', ['tests/*.test.ts']),
        // With the example plugin and the fixture carrier (a provider, granted buyer details)
        // installed (tests/plugins/).
        project(
          'plugins',
          ['tests/plugins/**/*.test.ts'],
          {
            TEST_EXAMPLE_MIGRATIONS: await readD1Migrations('../../plugins/example/migrations'),
            TEST_CARRIER_MIGRATIONS: await readD1Migrations(
              '../../plugins/fixture-carrier/migrations',
            ),
            PLUGIN_GRANTS: JSON.stringify({
              'fixture-carrier': { personalData: 'send' },
              example: { capabilities: ['carts:external', 'orders:start', 'orders:cancel'] },
            }),
          },
          [
            await bundlePlugin('../../plugins/example/src/index.ts', {
              name: 'orderloop-plugin-example',
              d1: { DB: 'plugin-example' },
              bindings: { PLUGIN_KEY: 'test-plugin-key' },
            }),
            await bundlePlugin('../../plugins/fixture-carrier/src/index.ts', {
              name: 'orderloop-plugin-fixture-carrier',
              d1: { DB: 'plugin-fixture-carrier' },
              bindings: { PLUGIN_KEY: 'test-carrier-key' },
            }),
          ],
        ),
        // The same plugins sandboxed: bundles the tests stage in DOCS, pinned in PLUGIN_BUNDLES and
        // loaded through Worker Loader (tests/sandboxed/). The example's secrets come from
        // PLUGIN_SECRETS (a shared account), the carrier's API_KEY from a Secrets Store binding
        // (its own account); api.carrier.test and *.allowed.test answer from `carrierUpstream`.
        project(
          'sandboxed',
          ['tests/sandboxed/**/*.test.ts'],
          {
            TEST_BUNDLES: JSON.stringify(sandboxed),
            PLUGIN_BUNDLES: JSON.stringify(
              Object.fromEntries(Object.entries(sandboxed).map(([id, b]) => [id, b.sha])),
            ),
            PLUGIN_SECRETS: JSON.stringify({ example: { PING_TOKEN: 'ping-secret-8f2d' } }),
            PLUGIN_GRANTS: JSON.stringify({
              'fixture-carrier': { personalData: 'send' },
              example: { capabilities: ['carts:external', 'orders:start', 'orders:cancel'] },
            }),
          },
          [],
          {
            secretsStoreSecrets: {
              PLUGIN_SECRET_FIXTURE_CARRIER__API_KEY: {
                store_id: '0123456789abcdef0123456789abcdef',
                secret_name: 'PLUGIN_FIXTURE_CARRIER_API_KEY',
              },
            },
            outboundService: carrierUpstream,
          },
        ),
        // Runtime installs (tests/installs/): no plugin pinned by the deployment, one trusted
        // publisher whose private key the tests sign with, and the carrier at two versions.
        project(
          'installs',
          ['tests/installs/**/*.test.ts'],
          {
            PLUGIN_PUBLISHERS: JSON.stringify({ acme: publisher.publicKey }),
            // The fixture carrier is what these tests install; a deployment never may.
            PLUGIN_TEST_FIXTURES: 'true',
            // The assistant may draft rule plugins (tests/installs/drafts.test.ts).
            ASSISTANT_PLUGINS: 'on',
            TEST_PUBLISHER_JWK: JSON.stringify(publisher.privateJwk),
            TEST_INSTALL_BUNDLES: JSON.stringify(installBundles),
          },
          [],
          { outboundService: carrierUpstream },
        ),
        // Payments through Stripe, against the in-memory fake in tests/stripe-fake.ts.
        // The punchout plugin sandboxed, granted its three capabilities: a procurement system's setup,
        // the buyer's cart and return, and its PO, against the real host API (tests/punchout/).
        project('punchout', ['tests/punchout/**/*.test.ts'], {
          TEST_BUNDLES: JSON.stringify(punchout),
          PLUGIN_BUNDLES: JSON.stringify({ punchout: punchout.punchout.sha }),
          PLUGIN_GRANTS: JSON.stringify({
            punchout: { capabilities: ['carts:external', 'orders:start', 'orders:cancel'] },
          }),
        }),
        project('stripe', ['tests/stripe/**/*.test.ts'], {
          PAYMENTS_MODE: 'stripe',
          STRIPE_SECRET_KEY: 'sk_test_fake',
          STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
        }),
      ],
    },
  };
});
