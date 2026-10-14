import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import agents from 'agents/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/migrations');
  // The demo customers, catalog and stores the tests order against (not part of the migrations).
  const seed = await readD1Migrations('../../packages/db/seed');
  return {
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
            AI_MODE: 'mock',
            TIME_SCALE: '1',
          },
          // A second, empty database for testing migrations against rows in an older shape.
          d1Databases: { MIGRATION_DB: 'migration-test' },
        },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
    },
  };
});
