import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  bundleSigningMessage,
  decryptSecret,
  type OrderInput,
  type OrderState,
  sealedWithCurrent,
  validateGraph,
} from '@orderloop/core';
import { createDb, flows, installedPlugins, pluginSecrets, publishFlow } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resealSecrets } from '../../src/data-key';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { dropInstallsCache, resolveSecret } from '../../src/plugin-host';
import * as installs from '../../src/plugin-installs';
import { pluginStatuses, registry } from '../../src/plugins';
import { edge, node, settled, stampInput } from '../plugin-helpers';

const testEnv = env as Env & {
  TEST_PUBLISHER_JWK: string;
  TEST_INSTALL_BUNDLES: string;
  DATA_KEY: string;
};
const bundles = JSON.parse(testEnv.TEST_INSTALL_BUNDLES) as Record<
  'v1' | 'v2',
  { body: string; sha: string }
>;
const db = () => createDb(env.DB);
const ADMIN = 'usr_admin';
const shipTo = { line1: '1 Main St', city: 'Springfield', postalCode: '62701', country: 'US' };

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

type Signer = Parameters<typeof crypto.subtle.sign>[1];
const acme = () =>
  crypto.subtle.importKey(
    'jwk',
    JSON.parse(testEnv.TEST_PUBLISHER_JWK),
    { name: 'Ed25519' },
    false,
    ['sign'],
  ) as Promise<Signer>;

/** A `.olplugin` file, as `pnpm plugin:pack` writes one; anything about it can be overridden. */
async function olplugin(
  body: string,
  over: { id?: string; version?: string; sha?: string; publisher?: string; key?: Signer } = {},
) {
  const id = over.id ?? 'fixture-carrier';
  const version =
    over.version ?? (JSON.parse(body) as { manifest: { version: string } }).manifest.version;
  const sha = over.sha ?? (await sha256(body));
  const signature = b64url(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      over.key ?? (await acme()),
      new TextEncoder().encode(bundleSigningMessage(id, version, sha)),
    ),
  );
  return JSON.stringify({
    format: 1,
    id,
    version,
    sha,
    body,
    publisher: over.publisher ?? 'acme',
    signature,
  });
}

const rogue = async () =>
  (
    (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as unknown as {
      privateKey: Signer;
    }
  ).privateKey;

/** start → reserve → price → rates (provider: the installed carrier) → end. */
const ratesFlow = (id: string) => ({
  id,
  name: 'Installed carrier rates',
  description: '',
  model: 'b2b',
  channels: [],
  nodes: [
    node('start', 'trigger.manual'),
    node('reserve', 'commerce.reserve_inventory'),
    node('price', 'commerce.price'),
    node('rates', 'commerce.shipping_rate', { provider: 'fixture-carrier', select: 'cheapest' }),
    node('done', 'control.end', { outcome: 'completed', reason: 'rated' }),
  ],
  edges: [
    edge('start', 'reserve'),
    edge('reserve', 'price', 'ok'),
    edge('price', 'rates'),
    edge('rates', 'done', 'ok'),
  ],
});

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
async function rate(input: Partial<OrderInput> = {}) {
  await introspector?.dispose();
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, {
    flowId: 'test-installed-rates',
    input: { ...stampInput(), meta: { shipTo, simulate: 'live_rates' }, ...input },
  });
  const done = (await settled(orderId, 45_000)) as OrderState;
  return (done.nodes.rates as { output?: { option?: { title?: string } } } | undefined)?.output
    ?.option?.title;
}

const status = async () =>
  (await pluginStatuses(env, true)).find((s) => s.id === 'fixture-carrier');

beforeAll(async () => {
  await ensureTemplates(env);
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
  dropInstallsCache();
});

describe('installing a plugin at runtime', () => {
  it('refuses a bundle the deployment can’t trust', async () => {
    const v1 = bundles.v1.body;
    const refused = async (file: string, e = env) =>
      installs.uploadPlugin(e, file, ADMIN).then(
        () => 'installed',
        (err: Error) => err.message,
      );
    expect(await refused(await olplugin(v1), { ...env, PLUGIN_PUBLISHERS: '' } as Env)).toBe(
      'Runtime installs are off for this deployment',
    );
    expect(await refused('not json')).toMatch(/not a plugin bundle/);
    expect(await refused(await olplugin(v1), { ...env, PLUGIN_TEST_FIXTURES: '' } as Env)).toMatch(
      /test fixture/,
    );
    expect(await refused(await olplugin(v1, { publisher: 'nobody' }))).toMatch(
      /“nobody” is not a publisher this deployment trusts/,
    );
    expect(await refused(await olplugin(v1, { key: await rogue() }))).toMatch(
      /signature isn't acme's/,
    );
    expect(await refused(await olplugin(v1, { sha: 'f'.repeat(64) }))).toMatch(
      /not what was signed/,
    );
    expect(await refused(await olplugin(v1, { version: '9' }))).toMatch(
      /fixture-carrier 1, signed as fixture-carrier 9/,
    );
    // Its manifest sealed as version 2 while its code still answers 1: never installed.
    const drifted = JSON.stringify({
      ...(JSON.parse(v1) as object),
      manifest: { ...(JSON.parse(v1) as { manifest: object }).manifest, version: '2' },
    });
    expect(await refused(await olplugin(drifted))).toMatch(/answers with another manifest/);
    const pinned = {
      ...env,
      PLUGIN_BUNDLES: JSON.stringify({ 'fixture-carrier': bundles.v1.sha }),
    } as Env;
    expect(await refused(await olplugin(v1), pinned)).toMatch(
      /installed by this deployment's registry/,
    );
    expect(await db().select().from(installedPlugins)).toEqual([]);
  });

  it('runs a reviewed, approved install, with the secret its admin set injected at egress', async () => {
    const review = await installs.uploadPlugin(env, await olplugin(bundles.v1.body), ADMIN);
    expect(review).toMatchObject({
      id: 'fixture-carrier',
      version: '1',
      publisher: 'acme',
      status: 'pending',
      secrets: [{ name: 'API_KEY', set: false }],
    });
    expect(review.manifest.egress).toEqual(['api.carrier.test']);
    // Pending: not installed, so a flow can't name it.
    expect(await status()).toBeUndefined();
    expect(
      validateGraph(ratesFlow('x'), await registry(env)).errors.map((e) => e.message),
    ).toContain('rates: Provider: plugin “fixture-carrier” is not installed');

    await expect(
      installs.approvePlugin(env, 'fixture-carrier', review.sha, { personalData: false }, ADMIN),
    ).rejects.toThrow(/needs buyer details/);

    await installs.setPluginSecret(env, 'fixture-carrier', 'API_KEY', 'sk-admin-1111', ADMIN);
    await expect(
      installs.setPluginSecret(env, 'fixture-carrier', 'OTHER', 'x', ADMIN),
    ).rejects.toThrow(/doesn't declare a secret named OTHER/);
    const sealed = await db().select().from(pluginSecrets).get();
    expect(sealed!.value).not.toContain('sk-admin');

    await installs.approvePlugin(env, 'fixture-carrier', review.sha, { personalData: true }, ADMIN);
    expect(await status()).toMatchObject({
      runtime: 'sandboxed',
      source: 'installed',
      healthy: true,
    });
    await publishFlow(db(), ratesFlow('test-installed-rates'));
    expect(await rate()).toBe('key 1111');
    const [listed] = await installs.listPluginInstalls(env);
    expect(listed).toMatchObject({
      status: 'active',
      personalDataGranted: true,
      secrets: [{ set: true }],
    });
    expect(JSON.stringify(listed)).not.toContain('sk-admin');
    // Should the registry install its own fixture-carrier, the admin's secret isn't its.
    const pinned = {
      ...env,
      PLUGIN_BUNDLES: JSON.stringify({ 'fixture-carrier': 'f'.repeat(64) }),
    } as Env;
    expect(await resolveSecret(pinned, 'fixture-carrier', 'API_KEY')).toBeUndefined();
    expect(await resolveSecret(env, 'fixture-carrier', 'API_KEY')).toBe('sk-admin-1111');
  });

  it('upgrades, rolls back, and disables', async () => {
    const v2 = await installs.uploadPlugin(env, await olplugin(bundles.v2.body), ADMIN);
    // A retried upload answers with the same review.
    expect(await installs.uploadPlugin(env, await olplugin(bundles.v2.body), ADMIN)).toMatchObject({
      sha: v2.sha,
      status: 'pending',
    });
    await installs.approvePlugin(env, 'fixture-carrier', v2.sha, { personalData: true }, ADMIN);
    // Approved once: a second approval (another admin, at the same time) is refused.
    await expect(
      installs.approvePlugin(env, 'fixture-carrier', v2.sha, { personalData: true }, ADMIN),
    ).rejects.toThrow(/is active/);
    await expect(
      installs.uploadPlugin(env, await olplugin(bundles.v2.body), ADMIN),
    ).rejects.toThrow(/already uploaded/);
    const byVersion = async () =>
      Object.fromEntries(
        (await db().select().from(installedPlugins)).map((r) => [r.version, r.status]),
      );
    expect(await byVersion()).toEqual({ '1': 'superseded', '2': 'active' });
    expect((await status())?.manifest?.version).toBe('2');

    // A publisher taken off the registry: none of its versions starts running again.
    const untrusted = {
      ...env,
      PLUGIN_PUBLISHERS: JSON.stringify({ other: 'x'.repeat(43) }),
    } as Env;
    await expect(
      installs.rollbackPlugin(untrusted, 'fixture-carrier', bundles.v1.sha),
    ).rejects.toThrow(/acme, who signed fixture-carrier 1, is no longer trusted/);
    await installs.rollbackPlugin(env, 'fixture-carrier', bundles.v1.sha);
    dropInstallsCache();
    expect(await byVersion()).toEqual({ '1': 'active', '2': 'superseded' });
    expect((await status())?.manifest?.version).toBe('1');

    await installs.setPluginEnabled(env, 'fixture-carrier', false);
    dropInstallsCache();
    expect(await status()).toBeUndefined();
    await installs.setPluginEnabled(env, 'fixture-carrier', true);
    dropInstallsCache();
    expect(await status()).toMatchObject({ healthy: true });
  });

  it('reseals its secrets with the deployment’s key', async () => {
    const NEXT = 'next-data-key-for-plugin-secrets';
    await resealSecrets({ ...env, DATA_KEY: NEXT, DATA_KEY_PREVIOUS: testEnv.DATA_KEY } as Env);
    const row = await db().select().from(pluginSecrets).get();
    expect(await sealedWithCurrent([NEXT], row!.value)).toBe(true);
    expect(await decryptSecret([NEXT], row!.value, 'plugin_secrets:fixture-carrier:API_KEY')).toBe(
      'sk-admin-1111',
    );
    // Back under the test key, for what follows.
    await resealSecrets({ ...env, DATA_KEY: testEnv.DATA_KEY, DATA_KEY_PREVIOUS: NEXT } as Env);
  });

  it('uninstalls only once nothing uses it, taking its secrets and storage with it', async () => {
    await expect(installs.uninstallPlugin(env, 'fixture-carrier')).rejects.toThrow(
      /still in use: 1 published flows/,
    );
    await db()
      .update(flows)
      .set({ archivedAt: Date.now() })
      .where(eq(flows.id, 'test-installed-rates'));
    await installs.uninstallPlugin(env, 'fixture-carrier');
    dropInstallsCache();
    expect(await status()).toBeUndefined();
    expect(await db().select().from(pluginSecrets)).toEqual([]);
    const rows = await db().select().from(installedPlugins);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['uninstalled']));
    const { rows: left } = (await env.PLUGIN_STORAGE.getByName('fixture-carrier').query(
      'fixture-carrier',
      bundles.v1.sha,
      { sql: 'SELECT count(*) AS n FROM labels', params: [] },
    )) as unknown as { rows: { n: number }[] };
    expect(left[0]!.n).toBe(0);
  });

  it('installs again after an uninstall, with one version running however two admins approve', async () => {
    const [v1, v2] = await Promise.all([
      installs.uploadPlugin(env, await olplugin(bundles.v1.body), ADMIN),
      installs.uploadPlugin(env, await olplugin(bundles.v2.body), ADMIN),
    ]);
    expect([v1.status, v2.status]).toEqual(['pending', 'pending']);
    expect(v1.secrets).toEqual([{ name: 'API_KEY', set: false }]);
    await installs.setPluginSecret(env, 'fixture-carrier', 'API_KEY', 'sk-admin-2222', ADMIN);
    const approve = (sha: string) =>
      installs.approvePlugin(env, 'fixture-carrier', sha, { personalData: true }, ADMIN);
    await Promise.allSettled([approve(v1.sha), approve(v2.sha)]);
    const running = (await db().select().from(installedPlugins)).filter(
      (r) => r.status === 'active' || r.status === 'disabled',
    );
    expect(running).toHaveLength(1);
    expect(running[0]!.approvedBy).toBe(ADMIN);
  });
});
