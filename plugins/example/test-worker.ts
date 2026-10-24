/**
 * The example plugin as a Miniflare auxiliary Worker, for the engine's and web app's vitest
 * configs: bundled from source on each run (Miniflare takes JavaScript), with its own D1 database.
 * A test reaches that database as `EXAMPLE_DB` when its project binds the same id.
 */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const EXAMPLE_PLUGIN = 'orderloop-plugin-example';
export const EXAMPLE_DB_ID = 'plugin-example';

export async function examplePluginWorker(principalKey: string) {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    write: false,
  });
  return {
    name: EXAMPLE_PLUGIN,
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: EXAMPLE_DB_ID },
    bindings: { PRINCIPAL_KEY: principalKey },
  };
}
