/**
 * CI's "Publish sandboxed plugins" step: builds a plugin's sandbox bundle and writes it to a file,
 * printing its sha. Node only.
 *
 *   node scripts/plugin-bundle.ts plugins/<id> <out file> [manifest file]
 *
 * With a manifest file, it also writes the parsed manifest from the plugin's src/manifest.ts.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSandboxBundle, readManifest } from '../packages/plugin-sdk/src/testing.ts';

const [dir, out, manifestOut] = process.argv.slice(2);
if (!dir || !out)
  throw new Error('usage: plugin-bundle.ts plugins/<id> <out file> [manifest file]');
const { body, sha } = await buildSandboxBundle(join(dir, 'src/index.ts'), join(dir, 'migrations'));
await writeFile(out, body);
if (manifestOut)
  await writeFile(manifestOut, JSON.stringify(await readManifest(join(dir, 'src/manifest.ts'))));
console.log(sha);
