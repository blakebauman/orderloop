import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { bundlePlugin } from '@orderloop/plugin-sdk/testing';
import agents from 'agents/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/migrations');
  // The demo customers, catalog and stores the tests order against (not part of the migrations).
  const seed = await readD1Migrations('../../packages/db/seed');
  // The demo deployment's nightly reset (.github/workflows/demo-reset.yml).
  const demoReset = await readD1Migrations('../../packages/db/reset');

  /** One workerd project: the engine Worker with these extra bindings (and auxiliary Workers). */
  const project = (
    name: string,
    include: string[],
    bindings: Record<string, unknown> = {},
    plugins: Awaited<ReturnType<typeof bundlePlugin>>[] = [],
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
            // The example plugin's own database, so its tests can read what it wrote.
            ...(plugins.length ? { EXAMPLE_DB: 'plugin-example' } : {}),
          },
          ...(plugins.length
            ? { workers: plugins, serviceBindings: { PLUGIN_EXAMPLE: 'orderloop-plugin-example' } }
            : {}),
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
        // With the example plugin installed (tests/plugins/).
        project(
          'plugins',
          ['tests/plugins/**/*.test.ts'],
          { TEST_EXAMPLE_MIGRATIONS: await readD1Migrations('../../plugins/example/migrations') },
          [
            await bundlePlugin('../../plugins/example/src/index.ts', {
              name: 'orderloop-plugin-example',
              d1: { DB: 'plugin-example' },
              bindings: { PRINCIPAL_KEY: 'test-principal-key' },
            }),
          ],
        ),
        // Payments through Stripe, against the in-memory fake in tests/stripe-fake.ts.
        project('stripe', ['tests/stripe/**/*.test.ts'], {
          PAYMENTS_MODE: 'stripe',
          STRIPE_SECRET_KEY: 'sk_test_fake',
          STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
        }),
      ],
    },
  };
});
