import { type PluginExecRequest, PRINCIPAL_HEADER, signPrincipal } from '@orderloop/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { checkDefinition, definePlugin } = await import('../src/index');
const { pluginContract } = await import('../src/contract');

const KEY = 'sdk-test-key';

type Env = { PLUGIN_KEY: string; rows: Map<string, string>; seen: Set<string> };

const manifest = {
  apiVersion: 1 as const,
  id: 'demo',
  name: 'Demo',
  version: '1',
  nodes: [
    {
      type: 'demo.stamp',
      category: 'commerce' as const,
      label: 'Stamp',
      description: '',
      icon: 'Stamp',
      fields: [],
      outputs: ['ok', 'no'],
      rollback: true,
    },
  ],
  events: ['order.completed' as const],
  nav: [{ label: 'Demo', path: '/plugins/demo/', icon: 'Puzzle' }],
  publicPaths: ['/plugins/demo/ping'],
};

/** A well-behaved plugin over in-memory "tables". */
const good = () =>
  definePlugin<Env>({
    manifest,
    nodes: {
      stamp: {
        execute: ({ env, key, req, fail }) => {
          if (req.config.decline) return fail('Declined');
          env.rows.set(key, req.orderId);
          return { output: { key }, summary: 'Stamped' };
        },
        compensate: ({ env, key }) => (env.rows.delete(key) ? 'Removed' : 'Nothing to remove'),
      },
    },
    events: {
      'order.completed': (p, env) => {
        env.seen.add(p.id);
      },
    },
    pages: (_req, { principal }) => Response.json({ who: principal?.id ?? null }),
  });

const instance = (Plugin: ReturnType<typeof good>) => {
  const env: Env = { PLUGIN_KEY: KEY, rows: new Map(), seen: new Set() };
  return { plugin: new Plugin({} as never, env), env };
};

const cases = (env: Env) => ({
  effects: async (orderId: string) => [...env.rows.values()].filter((o) => o === orderId).length,
  deliveries: async (id: string) => (env.seen.has(id) ? 1 : 0),
  principalKey: KEY,
});

const req = (over: Partial<PluginExecRequest> = {}): PluginExecRequest => ({
  type: 'demo.stamp',
  nodeId: 'n',
  stepKey: 'n#1',
  orderId: 'ord_1',
  config: {},
  order: {} as never,
  vars: {},
  nodes: {},
  ...over,
});

describe('definePlugin', () => {
  it('checks the manifest and its handlers when the plugin loads', () => {
    expect(() => checkDefinition({ manifest: { ...manifest, apiVersion: 2 as never } })).toThrow(
      /apiVersion/,
    );
    expect(() => checkDefinition({ manifest, pages: () => new Response() })).toThrow(
      /demo.stamp has no handler/,
    );
    expect(() =>
      checkDefinition({
        manifest,
        nodes: { stamp: { execute: () => ({}) } },
        pages: () => new Response(),
      }),
    ).toThrow(/rollback but no compensate/);
    expect(() =>
      checkDefinition({
        manifest: { ...manifest, nav: [], publicPaths: [] },
        nodes: {
          stamp: { execute: () => ({}), compensate: () => '' },
          other: { execute: () => ({}) },
        },
        events: { 'order.shipped': () => {} },
      }),
    ).toThrow(
      /nodes.other is not a node.*events.order.shipped is not in.*subscribes to order.completed but events has no handler/,
    );
    expect(() =>
      checkDefinition({
        manifest,
        nodes: { stamp: { execute: () => ({}), compensate: () => '' } },
      }),
    ).toThrow(/no pages handler/);
  });

  it('runs a node with its write key, and fails it on request', async () => {
    const { plugin, env } = instance(good());
    expect(await plugin.execute(req())).toEqual({
      output: { key: 'ord_1:n#1' },
      summary: 'Stamped',
    });
    expect([...env.rows.keys()]).toEqual(['ord_1:n#1']);
    expect(await plugin.execute(req({ config: { decline: true } }))).toEqual({
      fail: { message: 'Declined', retry: false },
    });
    expect(await plugin.execute(req({ type: 'demo.other' }))).toMatchObject({
      fail: { message: 'demo.other is not a node of demo' },
    });
    expect(await plugin.compensate({ ...req(), output: null })).toBe('Removed');
    expect(await plugin.compensate({ ...req(), output: null })).toBe('Nothing to remove');
    // A node it no longer has can't be undone: it says so rather than reporting success.
    await expect(
      plugin.compensate({ ...req({ type: 'demo.gone' }), output: null }),
    ).rejects.toThrow(/can't be undone/);
  });

  it('dispatches events by name and ignores the rest', async () => {
    const { plugin, env } = instance(good());
    const p = { id: 'd1', occurredAt: 0, orderId: 'o', data: {} };
    await plugin.deliver({ ...p, event: 'order.completed' });
    await plugin.deliver({ ...p, id: 'd2', event: 'order.shipped' });
    expect([...env.seen]).toEqual(['d1']);
  });

  it('serves pages only to a verified person with the page role', async () => {
    const { plugin } = instance(good());
    const get = async (path: string, role?: 'viewer' | 'operator') => {
      const headers: Record<string, string> = {};
      if (role)
        headers[PRINCIPAL_HEADER] = await signPrincipal(
          KEY,
          { kind: 'user', id: 'usr_1', name: 'Ada', role },
          path,
        );
      return plugin.fetch(new Request(`https://plugin${path}`, { headers }));
    };
    expect((await get('/plugins/demo/')).status).toBe(401);
    expect((await get('/plugins/demo/', 'viewer')).status).toBe(403);
    expect(await (await get('/plugins/demo/', 'operator')).json()).toEqual({ who: 'usr_1' });
    expect(await (await get('/plugins/demo/ping')).json()).toEqual({ who: null });
  });
});

describe('pluginContract', () => {
  it('passes a plugin that keeps the contract', async () => {
    const { plugin, env } = instance(good());
    expect(await pluginContract(plugin, cases(env))).toEqual([]);
  });

  it('catches a node that writes again on a retry', async () => {
    let n = 0;
    const Plugin = definePlugin<Env>({
      manifest: { ...manifest, nav: [], publicPaths: [], events: [] },
      nodes: {
        stamp: {
          execute: ({ env, req }) => {
            env.rows.set(`${req.orderId}:${n++}`, req.orderId);
            return {};
          },
          compensate: () => 'ok',
        },
      },
    });
    const env: Env = { PLUGIN_KEY: KEY, rows: new Map(), seen: new Set() };
    const problems = await pluginContract(new Plugin({} as never, env), cases(env));
    expect(problems.join('\n')).toMatch(/execute wrote again.*\n.*compensating twice left/);
  });

  it('catches a node keyed by the order alone, and one that writes nothing', async () => {
    const byOrder = definePlugin<Env>({
      manifest: { ...manifest, nav: [], publicPaths: [], events: [] },
      nodes: {
        stamp: {
          execute: ({ env, req }) => {
            env.rows.set(req.orderId, req.orderId);
            return {};
          },
          compensate: ({ env, req }) => (env.rows.delete(req.orderId) ? 'Removed' : 'None'),
        },
      },
    });
    const env: Env = { PLUGIN_KEY: KEY, rows: new Map(), seen: new Set() };
    expect(await pluginContract(new byOrder({} as never, env), cases(env))).toEqual([
      'demo.stamp: a run with another step key wrote nothing; key writes by order id and step key, not the order alone',
    ]);

    const idle = definePlugin<Env>({
      manifest: { ...manifest, nav: [], publicPaths: [], events: [] },
      nodes: { stamp: { execute: () => ({}), compensate: () => 'None' } },
    });
    const env2: Env = { PLUGIN_KEY: KEY, rows: new Map(), seen: new Set() };
    expect(await pluginContract(new idle({} as never, env2), cases(env2))).toEqual([
      'demo.stamp: execute wrote nothing the effects() probe sees; list it in noEffects if it writes nothing',
    ]);
    expect(
      await pluginContract(new idle({} as never, env2), {
        ...cases(env2),
        noEffects: ['demo.stamp'],
      }),
    ).toEqual([]);
  });

  it('catches a page that lets anyone in and a delivery recorded twice', async () => {
    const { plugin, env } = instance(good());
    const leaky = {
      manifest: () => plugin.manifest(),
      execute: (r: PluginExecRequest) => plugin.execute(r),
      compensate: plugin.compensate.bind(plugin),
      deliver: async () => {
        env.seen.add(`x${env.seen.size}`);
      },
      fetch: async () => new Response('hello'),
    };
    const problems = await pluginContract(leaky, {
      ...cases(env),
      deliveries: async () => env.seen.size,
    });
    expect(problems).toEqual([
      'events: delivering whd_contract_1 twice recorded it 2 times',
      'pages: /plugins/demo/ answered 200 without a signed-in person, not 401',
      'pages: /plugins/demo/ answered 200 to the role approver, not 403',
    ]);
  });

  it('reports a manifest that does not parse', async () => {
    const { plugin, env } = instance(good());
    const old = { ...plugin, manifest: async () => ({ ...manifest, apiVersion: 0 }) as never };
    expect((await pluginContract(old as never, cases(env)))[0]).toMatch(/^manifest: .*apiVersion/);
  });
});
