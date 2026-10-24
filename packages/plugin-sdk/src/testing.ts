/**
 * Runs a plugin as a Miniflare auxiliary Worker in another package's vitest config (the engine's
 * `plugins` project binds plugins/example this way). Bundles it from source on each run, since
 * Miniflare takes JavaScript, and gives it its own D1 database: a test reaches that database too by
 * binding the same id. Node only: import it from a vitest config, not from a test.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PluginManifest } from '@orderloop/core';
import { build } from 'esbuild';

export type BundleOptions = {
  /** The Worker name other Workers bind to. */
  name: string;
  /** D1 bindings, binding → database id. */
  d1?: Record<string, string>;
  /** Plain bindings: vars and secrets such as PRINCIPAL_KEY. */
  bindings?: Record<string, string>;
};

/**
 * A sandboxed plugin as the engine loads it: its code as one ES module, its migrations in order,
 * and its manifest as CI read it from `src/manifest.ts`. `sha` (SHA-256, hex, of the canonical
 * JSON of all three) names it in R2 and pins it in the deployment (`PLUGIN_BUNDLES`). The engine
 * enforces the plugin's egress, secrets and limits from this pinned manifest, and refuses the
 * plugin if the one its code answers with differs.
 */
export type SandboxBundle = {
  code: string;
  migrations: { name: string; sql: string }[];
  manifest: PluginManifest;
};

/** The bundle's bytes as stored, and its name. */
export function sealBundle(bundle: SandboxBundle) {
  const body = JSON.stringify({
    code: bundle.code,
    migrations: bundle.migrations,
    manifest: bundle.manifest,
  });
  return { body, sha: createHash('sha256').update(body).digest('hex') };
}

/**
 * Builds a plugin's sandbox bundle from its entry, its migrations folder (if any) and its manifest
 * module (`src/manifest.ts` next to the entry). This runs the plugin's manifest module: in CI, only
 * in a job that holds no secrets.
 */
export async function buildSandboxBundle(entry: string, migrationsDir?: string) {
  const code = await bundleCode(entry);
  const manifest = await readManifest(join(dirname(entry), 'manifest.ts'));
  const migrations = [];
  if (migrationsDir)
    for (const name of (await readdir(migrationsDir).catch(() => []))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      migrations.push({ name, sql: await readFile(join(migrationsDir, name), 'utf8') });
  return { ...sealBundle({ code, migrations, manifest }), manifest };
}

/**
 * A plugin's manifest as the engine will parse it, read from its `src/manifest.ts` (a module with
 * no Worker imports, by convention) without running the plugin: CI checks it against the
 * deployment before anything deploys.
 */
export async function readManifest(manifestModule: string): Promise<PluginManifest> {
  // Bundled with core's parser, so it runs in Node as the engine would parse it.
  const out = await build({
    stdin: {
      contents: `import m from ${JSON.stringify(resolve(manifestModule))};\nimport { parseManifest } from '@orderloop/core';\nexport default parseManifest(m);`,
      resolveDir: dirname(resolve(manifestModule)),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  const url = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0]!.text).toString('base64')}`;
  return (await import(url)).default as PluginManifest;
}

async function bundleCode(entry: string) {
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
  return out.outputFiles[0]!.text;
}

export async function bundlePlugin(entry: string, opts: BundleOptions) {
  return {
    name: opts.name,
    modules: true,
    script: await bundleCode(entry),
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: opts.d1 ?? {},
    bindings: opts.bindings ?? {},
  };
}
