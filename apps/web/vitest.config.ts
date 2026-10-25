import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // As in a build (vite.config.ts): replies render without rehype-raw.
    alias: { 'rehype-raw': fileURLToPath(new URL('./app/lib/rehype-raw-off.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // It imports `cloudflare:workers`; inlined, the tests' vi.mock of that module applies to it.
    // Streamdown is inlined so the alias below reaches its `rehype-raw` import.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider', 'streamdown'] } },
  },
});
