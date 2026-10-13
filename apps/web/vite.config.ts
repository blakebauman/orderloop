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
      // OrderAgent Durable Objects and Workflows all work locally. It deploys on its own.
      auxiliaryWorkers: [{ configPath: '../engine/wrangler.jsonc', devOnly: true }],
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
