import { adminSecretsStore, introspectWorkflow } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import {
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  pluginKey,
  signPrincipal,
} from '@orderloop/core';
import { createDb, pluginErrors, publishFlow } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { egressRefusal, knownManifests, limitsFor, pluginStub } from '../../src/plugin-host';
import { manifests, pluginStatuses } from '../../src/plugins';
import { edge, node, probeFlow, settled, stampFlow, stampInput } from '../plugin-helpers';

type Bundles = Record<string, { sha: string; body: string }>;
const testEnv = env as Env & {
  TEST_BUNDLES: string;
  PLUGIN_SECRET_FIXTURE_CARRIER__API_KEY: SecretsStoreSecret;
};
const bundles = JSON.parse(testEnv.TEST_BUNDLES) as Bundles;
const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);

/** SQL against a sandboxed plugin's own storage, as the plugin would run it. */
const storage = (id: string, sql: string, ...params: unknown[]) =>
  env.PLUGIN_STORAGE.getByName(id).query(id, bundles[id]!.sha, {
    sql,
    params,
  }) as unknown as Promise<{
    rows: Record<string, unknown>[];
  }>;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
async function run(flowId: string, input: Partial<OrderInput> = {}, rollback = true) {
  await introspector?.dispose();
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, { flowId, input: { ...stampInput(), ...input } });
  return { orderId, done: (await settled(orderId, 45_000, { rollback })) as OrderState };
}
const probe = (behave: string) => run(`test-sbx-probe-${behave}`, { lines: [] }, false);

/** start → reserve → rates (provider: the carrier) → end. */
const ratesFlow = (id: string) => ({
  id,
  name: 'Sandboxed rates',
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

/** A probe flow whose node fetches `url` (the example's "fetch" behaviour). */
const fetchFlow = (id: string, url: string) => {
  const f = probeFlow(id, 'fetch');
  f.nodes = f.nodes.map((n) => (n.id === 'probe' ? { ...n, config: { behave: 'fetch', url } } : n));
  return f;
};
const fetched = async (flowId: string) =>
  (await run(flowId, { lines: [] }, false)).done.nodes.probe as {
    output?: { status?: number; body?: string };
  };

const shipTo = { line1: '1 Main St', city: 'Springfield', postalCode: '62701', country: 'US' };

beforeAll(async () => {
  for (const [id, b] of Object.entries(bundles))
    await env.DOCS.put(`plugins/${id}/${b.sha}.json`, b.body);
  await adminSecretsStore(testEnv.PLUGIN_SECRET_FIXTURE_CARRIER__API_KEY).create('sk-store-AAAA');
  await ensureTemplates(env);
  await publishFlow(db(), stampFlow('test-sbx-stamp', 'completed'));
  await publishFlow(db(), stampFlow('test-sbx-stamp-fails', 'failed'));
  await publishFlow(db(), ratesFlow('test-sbx-rates'));
  for (const behave of ['env', 'leak', 'throw', 'post_big'])
    await publishFlow(db(), probeFlow(`test-sbx-probe-${behave}`, behave));
  const urls: Record<string, string> = {
    allowed: 'https://eu.allowed.test/',
    undeclared: 'https://elsewhere.test/',
    plain: 'http://api.carrier.test/',
    private: 'https://10.0.0.7/',
    redirect: 'https://eu.allowed.test/redirect',
  };
  for (const [name, url] of Object.entries(urls))
    await publishFlow(db(), fetchFlow(`test-sbx-fetch-${name}`, url));
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('a sandboxed plugin', () => {
  it('is installed from its pinned bundle and answers with its manifest', async () => {
    const statuses = await pluginStatuses(env, true);
    expect(statuses.map(({ id, runtime, healthy }) => ({ id, runtime, healthy }))).toEqual([
      { id: 'example', runtime: 'sandboxed', healthy: true },
      { id: 'fixture-carrier', runtime: 'sandboxed', healthy: true },
    ]);
    expect((await api().health()).checks).toMatchObject({
      plugin_example: 'ok',
      plugin_fixture_carrier: 'ok',
    });
  });

  it('gets only its capabilities as env', async () => {
    const { done } = await probe('env');
    expect((done.nodes.probe as { output?: unknown }).output).toEqual({
      keys: ['PLUGIN_KEY', 'SECRETS', 'STORAGE', '__ORDERLOOP_SANDBOX'],
    });
  });

  it('runs its node against its own storage, and undoes it when the order fails', async () => {
    const ok = await run('test-sbx-stamp');
    expect(ok.done.status).toBe('completed');
    expect(
      (await storage('example', 'SELECT step_key, note FROM stamps WHERE order_id = ?', ok.orderId))
        .rows,
    ).toEqual([{ step_key: 'stamp#1', note: 'hello' }]);

    const failed = await run('test-sbx-stamp-fails');
    expect(failed.done.status).toBe('rolled_back');
    expect(
      (await storage('example', 'SELECT * FROM stamps WHERE order_id = ?', failed.orderId)).rows,
    ).toEqual([]);
  });

  it('gets the events it subscribed to', async () => {
    const { orderId } = await run('test-sbx-stamp');
    for (let i = 0; i < 50; i++) {
      const { rows } = await storage(
        'example',
        'SELECT event FROM deliveries WHERE order_id = ?',
        orderId,
      );
      if (rows.length) return expect(rows).toEqual([{ event: 'order.completed' }]);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('order.completed was not delivered to the sandboxed plugin');
  });

  it('serves its pages through the engine, to a signed principal only', async () => {
    const path = '/plugins/example/';
    const page = (headers: Record<string, string> = {}) =>
      api().pluginFetch('example', new Request(`https://plugin${path}`, { headers }));
    expect((await page()).status).toBe(401);
    const key = await pluginKey(
      String((env as unknown as { PRINCIPAL_KEY: string }).PRINCIPAL_KEY),
      'example',
    );
    const header = await signPrincipal(
      key,
      { kind: 'user', id: 'usr_1', name: 'Ada', role: 'admin' },
      path,
    );
    const res = await page({ [PRINCIPAL_HEADER]: header });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plugin: 'example', principal: { id: 'usr_1' } });
    expect(
      (await api().pluginFetch('nope', new Request('https://plugin/plugins/nope/'))).status,
    ).toBe(404);
  });

  it('reads a secret it exposes, but never one injected for it', async () => {
    const ping = (auth?: string) =>
      api().pluginFetch(
        'example',
        new Request('https://plugin/plugins/example/public/ping', {
          headers: auth ? { authorization: auth } : {},
        }),
      );
    expect((await ping()).status).toBe(401);
    expect((await ping('Bearer ping-secret-8f2d')).status).toBe(200);

    await manifests(env);
    const secrets = (
      exports as unknown as Record<
        string,
        (o: unknown) => { get(n: string): Promise<string | null>; has(n: string): Promise<boolean> }
      >
    ).PluginSecrets!({ props: { id: 'fixture-carrier', sha: bundles['fixture-carrier']!.sha } });
    expect(await secrets.has('API_KEY')).toBe(true);
    expect(await secrets.get('API_KEY')).toBeNull();
  });

  it('has its credential injected at egress, from the Secrets Store, rotated without a reload', async () => {
    const rate = async () => {
      const { done } = await run('test-sbx-rates', { meta: { shipTo, simulate: 'live_rates' } });
      expect(done.status).toBe('completed');
      return (done.nodes.rates as { output?: { option?: { title?: string } } }).output?.option
        ?.title;
    };
    expect(await rate()).toBe('key AAAA');
    const admin = adminSecretsStore(testEnv.PLUGIN_SECRET_FIXTURE_CARRIER__API_KEY);
    const [stored] = await admin.list();
    await admin.update('sk-store-BBBB', stored!.metadata!.uuid);
    expect(await rate()).toBe('key BBBB');
  });

  it('reaches only https hosts in its egress, and no redirect takes it elsewhere', async () => {
    expect(await fetched('test-sbx-fetch-allowed')).toMatchObject({
      output: { status: 200, body: 'ok no auth' },
    });
    for (const [flow, why] of [
      ['undeclared', /elsewhere\.test is not in the plugin's egress/],
      ['plain', /only https/],
      ['private', /10\.0\.0\.7 is not a public host/],
      ['redirect', /evil\.test is not in the plugin's egress/],
    ] as const) {
      const r = await fetched(`test-sbx-fetch-${flow}`);
      expect(r.output?.status).toBe(403);
      expect(r.output?.body).toMatch(why);
    }
  });

  it('can’t write one of its secrets into the timeline or its logs', async () => {
    const { done } = await probe('leak');
    expect(done.status).toBe('failed');
    expect(done.nodes.probe!.error).toMatch(/token is \[redacted\]$/);
    expect(done.nodes.probe!.error).not.toMatch(/ping-secret/);

    // A thrown error comes back scrubbed too.
    const thrown = await probe('throw');
    expect(thrown.done.status).toBe('failed');
    expect(thrown.done.nodes.probe!.error).toMatch(/Probe exploded holding \[redacted\]/);

    // Its Tail Worker keeps its exceptions, scrubbed (local workerd doesn't send a Dynamic
    // Worker's tail events, so the handler is driven here as the runtime would).
    const tail = (
      exports as unknown as Record<string, (o: unknown) => { tail(e: unknown[]): Promise<void> }>
    ).PluginTail!({ props: { id: 'example', sha: bundles.example!.sha } });
    await tail.tail([
      {
        logs: [{ level: 'log', message: ['token ping-secret-8f2d'], timestamp: 1 }],
        exceptions: [
          { name: 'Error', message: 'Probe exploded holding ping-secret-8f2d', timestamp: 2 },
        ],
      },
    ]);
    const rows = await db().select().from(pluginErrors).where(eq(pluginErrors.pluginId, 'example'));
    expect(rows.map((r) => r.message)).toEqual(['Error: Probe exploded holding [redacted]']);
  });

  it('keeps the credential an upstream echoes out of the order', async () => {
    const { done } = await run('test-sbx-rates', { meta: { shipTo, simulate: 'echo_rates' } });
    const title = (done.nodes.rates as { output?: { option?: { title?: string } } }).output?.option
      ?.title;
    expect(title).toBe('sent Bearer [redacted]');
    expect(JSON.stringify(done)).not.toMatch(/sk-store-/);
  });

  it('refuses a request body over the cap', async () => {
    const { done } = await probe('post_big');
    expect((done.nodes.probe as { output?: { status?: number } }).output?.status).toBe(413);
  });

  it('enforces its pinned rules in an isolate that has never asked it for its manifest', async () => {
    knownManifests.clear();
    expect(await fetched('test-sbx-fetch-allowed')).toMatchObject({ output: { status: 200 } });
    expect((await fetched('test-sbx-fetch-undeclared')).output?.status).toBe(403);
  });

  it('is refused when its code answers with another manifest than the one pinned', async () => {
    const original = JSON.parse(bundles.example!.body) as { manifest: { egress: string[] } };
    original.manifest.egress = [...original.manifest.egress, 'attacker.test'];
    const body = JSON.stringify(original);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.DOCS.put(`plugins/example/${sha}.json`, body);
    const drifted = { ...env, PLUGIN_BUNDLES: JSON.stringify({ example: sha }) } as Env;
    const [status] = await pluginStatuses(drifted, true);
    expect(status).toMatchObject({ id: 'example', healthy: false });
    expect(status!.error).toMatch(/differs from the one pinned/);
  });

  it('applies its migrations once when two first calls race', async () => {
    const stub = env.PLUGIN_STORAGE.getByName('race-example');
    const q = () =>
      stub.query('example', bundles.example!.sha, {
        sql: 'SELECT count(*) AS n FROM stamps',
        params: [],
      });
    const [a, b] = await Promise.all([q(), q()]);
    expect([a, b].map((r) => (r as { rows: { n: number }[] }).rows[0]!.n)).toEqual([0, 0]);
  });

  it('runs only a bundle that matches its pin', async () => {
    const sha = 'f'.repeat(64);
    await env.DOCS.put(
      `plugins/tampered/${sha}.json`,
      JSON.stringify({ code: '', migrations: [] }),
    );
    const tampered = { ...env, PLUGIN_BUNDLES: JSON.stringify({ tampered: sha }) } as Env;
    await expect(pluginStub(tampered, 'tampered', 'serve')).rejects.toThrow(
      /doesn't match its pin/,
    );
  });
});

describe('the sandbox’s rules', () => {
  it('caps each call by what it is for', () => {
    expect(limitsFor('call')).toEqual({ cpuMs: 200, subRequests: 20 });
    expect(limitsFor('serve', { limits: { cpuMs: 5000 } })).toEqual({
      cpuMs: 1000,
      subRequests: 20,
    });
    expect(limitsFor('call', { limits: { cpuMs: 50, subRequests: 0 } })).toEqual({
      cpuMs: 50,
      subRequests: 0,
    });
  });

  it('refuses private, internal and wildcard-DNS hosts whatever the egress says', () => {
    const m = { egress: ['*.test', 'api.carrier.test'] };
    for (const url of [
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://[::ffff:a00:1]/',
      'https://169.254.169.254/',
      'https://100.64.0.1/',
      'https://[fd00::1]/',
      'https://metadata.google.internal/',
      'https://10.0.0.1.nip.io/',
      'https://user:pw@api.carrier.test/',
    ])
      expect(egressRefusal(m, new URL(url)), url).not.toBeNull();
    expect(egressRefusal(m, new URL('https://api.carrier.test/rates'))).toBeNull();
  });
});
