import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig } from 'vite';

/** Core's DEV_PRINCIPAL_KEY (Node can't load core's source here; tests/dev-key.test.ts keeps them equal). */
const DEV_PRINCIPAL_KEY = 'orderloop-local-dev-principal-key';

export default defineConfig({
  plugins: [
    // TC39 decorators in the engine's OrderAgent (`@callable()`); Oxc doesn't transform them yet.
    ...agents(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // A fleet deploy builds against its rendered config (`scripts/fleet.ts render <id>`).
      configPath: process.env.ORDERLOOP_WRANGLER_CONFIG,
      // In dev, run the engine Worker in the same session so the ENGINE service binding, its
      // OrderAgent Durable Objects and Workflows all work locally. It deploys on its own. Dev
      // compresses waits so scenarios finish in minutes (production runs in real time), calls
      // Workers AI directly rather than through production's AI Gateway and its rate limit, and
      // checks the principal header with the dev key the web Worker signs with in dev.
      auxiliaryWorkers: [
        {
          configPath: '../engine/wrangler.jsonc',
          config: {
            vars: { TIME_SCALE: '1440', AI_GATEWAY_ID: '', PRINCIPAL_KEY: DEV_PRINCIPAL_KEY },
          },
          devOnly: true,
        },
      ],
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
