/**
 * A plugin publisher's tool: signs a sandboxed plugin's bundle so a deployment that lists the
 * publisher (`pluginInstalls.publishers` in its registry) can install it at runtime, from its
 * Plugins page. See docs/plugins.md, "Installing at runtime". Node only; it never needs a
 * deployment's secrets, and its private key stays with the publisher.
 *
 *   node scripts/plugin-pack.ts keygen <publisher> <private key out (PEM)>
 *       writes the private key, prints the public key to list in a deployment's registry
 *   node scripts/plugin-pack.ts pack plugins/<id> <out.olplugin> --publisher <name> --key <pem>
 *       builds the bundle (as CI does) and signs it
 */

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSandboxBundle } from '../packages/plugin-sdk/src/testing.ts';

/** What a publisher signs (`bundleSigningMessage` in @orderloop/core; kept equal by the tests). */
export const signingMessage = (id: string, version: string, sha: string) =>
  `orderloop-plugin:1:${id}:${version}:${sha}`;

/** A new publisher key: the private key as PEM, the public one as the registry lists it. */
export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'jwk' }).x as string,
  };
}

/** Signs a built bundle body into an `.olplugin` file's JSON. */
export function signBundle(
  bundle: { body: string; sha: string; manifest: { id: string; version: string } },
  publisher: string,
  privatePem: string,
) {
  const { id, version } = bundle.manifest;
  const signature = sign(
    null,
    Buffer.from(signingMessage(id, version, bundle.sha)),
    createPrivateKey(privatePem),
  ).toString('base64url');
  return { format: 1, id, version, sha: bundle.sha, body: bundle.body, publisher, signature };
}

async function main(args: string[]) {
  const [cmd, ...rest] = args;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'keygen') {
    const [publisher, out] = rest;
    if (!publisher || !out) throw new Error('keygen <publisher> <private key out>');
    const { privatePem, publicKey } = keygen();
    // Never over an existing file: its permissions would stay, and a key would be lost.
    writeFileSync(out, privatePem, { mode: 0o600, flag: 'wx' });
    console.log(`Private key written to ${out}: keep it secret, never commit it.`);
    console.log(`List this in a deployment's registry to trust ${publisher}:`);
    console.log(JSON.stringify({ pluginInstalls: { publishers: { [publisher]: publicKey } } }));
    return;
  }
  if (cmd === 'pack') {
    const [dir, out] = rest;
    const publisher = flag('publisher');
    const key = flag('key');
    if (!dir || !out || !publisher || !key)
      throw new Error('pack plugins/<id> <out.olplugin> --publisher <name> --key <pem>');
    const bundle = await buildSandboxBundle(join(dir, 'src/index.ts'), join(dir, 'migrations'));
    const file = signBundle(bundle, publisher, readFileSync(key, 'utf8'));
    writeFileSync(out, JSON.stringify(file));
    console.log(
      `${file.id} ${file.version} (${file.sha.slice(0, 12)}) signed by ${publisher}: ${out}`,
    );
    return;
  }
  throw new Error('usage: plugin-pack.ts keygen|pack (see the header)');
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
