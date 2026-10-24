import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// catalog-edge in workerd with local R2 and KV. Workers Caching isn't emulated locally, so these
// tests check what reaches the cache (canonical URLs, headers, 304s); production checks the rest.
// The catalog's SearchApi is a stub Worker: "tee" matches uids 7, 70 and 71, nothing else matches.
const catalogStub = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class SearchApi extends WorkerEntrypoint {
  async search(channel, locale, q, limit, offset) {
    const all = q === 'tee' ? [7, 70, 71] : [];
    return { total: all.length, uids: all.slice(offset, offset + limit) };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        workers: [
          {
            name: 'orderloop-catalog',
            modules: true,
            script: catalogStub,
            compatibilityDate: '2026-10-01',
          },
        ],
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
