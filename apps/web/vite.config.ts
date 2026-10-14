import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // TC39 decorators in the engine's OrderAgent (`@callable()`); Oxc doesn't transform them yet.
    ...agents(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // In dev, run the engine Worker in the same session so the ENGINE service binding, its
      // OrderAgent Durable Objects and Workflows all work locally. It deploys on its own. Dev
      // compresses waits so scenarios finish in minutes (production runs in real time), and calls
      // Workers AI directly rather than through production's AI Gateway and its rate limit.
      auxiliaryWorkers: [
        {
          configPath: '../engine/wrangler.jsonc',
          config: { vars: { TIME_SCALE: '1440', AI_GATEWAY_ID: '' } },
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
