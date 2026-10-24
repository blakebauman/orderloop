import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The plugin in workerd with its own D1 (its migrations applied in tests/setup.ts), checked
// against the plugin contract.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          PLUGIN_KEY: 'punchout-test-key',
        },
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup.ts'] },
}));
