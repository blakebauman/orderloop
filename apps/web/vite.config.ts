import { createHmac } from 'node:crypto';
import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig } from 'vite';

/**
 * Core's DEV_PRINCIPAL_KEY and DEV_DATA_KEY (Node can't load core's source here;
 * tests/dev-key.test.ts keeps them equal).
 */
const DEV_PRINCIPAL_KEY = 'orderloop-local-dev-principal-key';
const DEV_DATA_KEY = 'orderloop-local-dev-data-key';

/**
 * Plugins to run in dev (`ORDERLOOP_DEV_PLUGINS=example pnpm web:dev`), each as one more auxiliary
 * Worker bound to the web app and the engine as PLUGIN_<ID>, as a deployment's registry would.
 * Apply a plugin's migrations first; see docs/plugins.md.
 */
const devPlugins = (process.env.ORDERLOOP_DEV_PLUGINS ?? '').split(',').filter(Boolean);
const pluginServices = devPlugins.map((p) => ({
  binding: `PLUGIN_${p.toUpperCase().replaceAll('-', '_')}`,
  service: `orderloop-plugin-${p}`,
}));
const withPlugins = (services: { binding: string; service: string }[] = []) => [
  ...services,
  ...pluginServices,
];

export default defineConfig({
  plugins: [
    // TC39 decorators in the engine's OrderAgent (`@callable()`); Oxc doesn't transform them yet.
    ...agents(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // A fleet deploy builds against its rendered config (`scripts/fleet.ts render <id>`).
      configPath: process.env.ORDERLOOP_WRANGLER_CONFIG,
      ...(devPlugins.length ? { config: (c) => ({ services: withPlugins(c.services) }) } : {}),
      // In dev, run the engine Worker in the same session so the ENGINE service binding, its
      // OrderAgent Durable Objects and Workflows all work locally. It deploys on its own. Dev
      // compresses waits so scenarios finish in minutes (production runs in real time), calls
      // Workers AI directly rather than through production's AI Gateway and its rate limit, and
      // checks the principal header with, and encrypts secrets under, the dev keys the web Worker
      // uses in dev.
      auxiliaryWorkers: [
        {
          configPath: '../engine/wrangler.jsonc',
          config: (c) => ({
            vars: {
              TIME_SCALE: '1440',
              AI_GATEWAY_ID: '',
              PRINCIPAL_KEY: DEV_PRINCIPAL_KEY,
              DATA_KEY: DEV_DATA_KEY,
              SIMULATE_FAILURES: 'true',
            },
            ...(devPlugins.length ? { services: withPlugins(c.services) } : {}),
          }),
          devOnly: true,
        },
        ...devPlugins.map((p) => ({
          configPath: `../../plugins/${p}/wrangler.jsonc`,
          // Its own key, as scripts/fleet.ts derives it: never the principal key.
          config: {
            vars: {
              PLUGIN_KEY: createHmac('sha256', DEV_PRINCIPAL_KEY)
                .update(`orderloop-plugin:${p}`)
                .digest('hex'),
            },
          },
          devOnly: true,
        })),
      ],
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
