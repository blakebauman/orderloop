/**
 * Runs a plugin as a Miniflare auxiliary Worker in another package's vitest config (the engine's
 * `plugins` project binds plugins/example this way). Bundles it from source on each run, since
 * Miniflare takes JavaScript, and gives it its own D1 database: a test reaches that database too by
 * binding the same id. Node only: import it from a vitest config, not from a test.
 */

import { build } from 'esbuild';

export type BundleOptions = {
  /** The Worker name other Workers bind to. */
  name: string;
  /** D1 bindings, binding → database id. */
  d1?: Record<string, string>;
  /** Plain bindings: vars and secrets such as PRINCIPAL_KEY. */
  bindings?: Record<string, string>;
};

export async function bundlePlugin(entry: string, opts: BundleOptions) {
  const out = await build({
    entryPoints: [entry],
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
    name: opts.name,
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: opts.d1 ?? {},
    bindings: opts.bindings ?? {},
  };
}
