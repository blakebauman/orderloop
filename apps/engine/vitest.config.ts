import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import agents from 'agents/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/migrations');
  // The demo customers, catalog and stores the tests order against (not part of the migrations).
  const seed = await readD1Migrations('../../packages/db/seed');
  // The demo deployment's nightly reset (.github/workflows/demo-reset.yml).
  const demoReset = await readD1Migrations('../../packages/db/reset');

  /** One workerd project: the engine Worker with these extra bindings. */
  const project = (name: string, include: string[], bindings: Record<string, unknown> = {}) => ({
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
            ...bindings,
          },
          // A second, empty database for testing migrations against rows in an older shape.
          d1Databases: { MIGRATION_DB: 'migration-test', DEMO_DB: 'demo-test' },
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
        // Payments in the default mock mode: `meta.simulate` drives declines.
        project('engine', ['tests/*.test.ts']),
        // Payments through Stripe, against the in-memory fake in tests/stripe-fake.ts.
        project('stripe', ['tests/stripe/**/*.test.ts'], {
          PAYMENTS_MODE: 'stripe',
          STRIPE_SECRET_KEY: 'sk_test_fake',
        }),
      ],
    },
  };
});
