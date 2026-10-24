import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// catalog-edge in workerd with local R2 and KV. Workers Caching isn't emulated locally, so these
// tests check what reaches the cache (canonical URLs, headers, 304s); production checks the rest.
export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, remoteBindings: false }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
