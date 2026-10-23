import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The catalog Worker in workerd, with local R2, KV and Durable Objects.
export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, remoteBindings: false }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
