import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The catalog Worker in workerd, with local R2, KV, Durable Objects and Order Loop's D1 (its
// migrations applied in tests/setup.ts, for the `products` rows the catalog keeps).
export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        // Small feed chunks, so a test feed spans several Workflow steps.
        miniflare: { bindings: { FEED_CHUNK: '300', TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
    },
  };
});
