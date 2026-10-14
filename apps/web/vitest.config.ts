import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // It imports `cloudflare:workers`; inlined, the tests' vi.mock of that module applies to it.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
