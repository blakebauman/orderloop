import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig, type Plugin } from 'vite';
import { buildSandboxBundle } from '../../packages/plugin-sdk/src/testing';

/**
 * Core's DEV_PRINCIPAL_KEY and DEV_DATA_KEY (Node can't load core's source here;
 * tests/dev-key.test.ts keeps them equal).
 */
const DEV_PRINCIPAL_KEY = 'orderloop-local-dev-principal-key';
const DEV_DATA_KEY = 'orderloop-local-dev-data-key';

/**
 * Plugins to run in dev (`ORDERLOOP_DEV_PLUGINS=example pnpm web:dev`), each as one more auxiliary
 * Worker bound to the web app and the engine as PLUGIN_<ID>, as a deployment's registry would
 * (apply its migrations first). `<id>:sandboxed` runs one sandboxed instead: its bundle is built
 * here and handed to the engine (PLUGIN_BUNDLES, and PLUGIN_DEV_BUNDLES since dev's DOCS bucket
 * doesn't have it), and its storage migrates itself. See docs/plugins.md.
 */
const devEntries = (process.env.ORDERLOOP_DEV_PLUGINS ?? '')
  .split(',')
  .filter(Boolean)
  .map((e) => ({ id: e.split(':')[0]!, sandboxed: e.split(':')[1] === 'sandboxed' }));
const devPlugins = devEntries.filter((e) => !e.sandboxed).map((e) => e.id);
const devSandboxed = devEntries.filter((e) => e.sandboxed).map((e) => e.id);
const pluginServices = devPlugins.map((p) => ({
  binding: `PLUGIN_${p.toUpperCase().replaceAll('-', '_')}`,
  service: `orderloop-plugin-${p}`,
}));
/**
 * A publisher dev trusts for runtime installs (`ORDERLOOP_DEV_PUBLISHER=<name>:<public key>`, from
 * `pnpm plugin:pack keygen`), as a deployment's registry lists them in `pluginInstalls`.
 */
const devPublisher = process.env.ORDERLOOP_DEV_PUBLISHER?.split(':');
const publisherVars: Record<string, string> =
  devPublisher?.length === 2
    ? { PLUGIN_PUBLISHERS: JSON.stringify({ [devPublisher[0]!]: devPublisher[1] }) }
    : {};
const withPlugins = (services: { binding: string; service: string }[] = []) => [
  ...services,
  ...pluginServices,
];

/**
 * The device tests (`pnpm --filter @orderloop/web e2e`) run the dev server offline: no remote
 * bindings, mock AI, and a database of their own under .wrangler/e2e so they never touch the one
 * `pnpm web:dev` uses.
 */
const e2e = process.env.ORDERLOOP_E2E === '1';

/**
 * In a build, Streamdown's `rehype-raw` import resolves to a no-op (`app/lib/rehype-raw-off.ts`),
 * which keeps parse5 out of the assistant panel. Build only: the dev server pre-bundles Streamdown
 * without asking this hook, so raw HTML in a reply still parses in dev.
 */
const withoutRehypeRaw = (): Plugin => ({
  name: 'orderloop:without-rehype-raw',
  enforce: 'pre',
  apply: 'build',
  resolveId: (id) =>
    id === 'rehype-raw'
      ? fileURLToPath(new URL('./app/lib/rehype-raw-off.ts', import.meta.url))
      : null,
});

export default defineConfig(async () => {
  const bundles = await Promise.all(
    devSandboxed.map(async (id) => ({
      id,
      ...(await buildSandboxBundle(
        `../../plugins/${id}/src/index.ts`,
        `../../plugins/${id}/migrations`,
      )),
    })),
  );
  const sandboxVars: Record<string, string> = bundles.length
    ? {
        PLUGIN_BUNDLES: JSON.stringify(Object.fromEntries(bundles.map((b) => [b.id, b.sha]))),
        PLUGIN_DEV_BUNDLES: JSON.stringify(Object.fromEntries(bundles.map((b) => [b.id, b.body]))),
        // The engine reads PLUGIN_DEV_BUNDLES only with this set (local dev only).
        DEV_SANDBOX: 'true',
      }
    : {};
  return {
    plugins: [
      withoutRehypeRaw(),
      // TC39 decorators in the engine's OrderAgent (`@callable()`); Oxc doesn't transform them yet.
      ...agents(),
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        // A fleet deploy builds against its rendered config (`scripts/fleet.ts render <id>`).
        configPath: process.env.ORDERLOOP_WRANGLER_CONFIG,
        ...(e2e ? { remoteBindings: false, persistState: { path: '.wrangler/e2e' } } : {}),
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
                APP_ORIGIN: 'http://localhost:5173',
                OWN_HOSTS: 'localhost',
                AI_GATEWAY_ID: '',
                PRINCIPAL_KEY: DEV_PRINCIPAL_KEY,
                DATA_KEY: DEV_DATA_KEY,
                SIMULATE_FAILURES: 'true',
                ...(e2e ? { AI_MODE: 'mock' } : {}),
                ...sandboxVars,
                ...publisherVars,
              },
              ...(devPlugins.length ? { services: withPlugins(c.services) } : {}),
            }),
            devOnly: true,
          },
          // The product catalog, so the Catalog page, /api/v1/catalog and the engine's CATALOG
          // binding work locally. It deploys on its own.
          { configPath: '../catalog/wrangler.jsonc', devOnly: true },
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
  };
});
