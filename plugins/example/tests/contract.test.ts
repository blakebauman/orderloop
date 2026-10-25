import { env } from 'cloudflare:workers';
import {
  checkPluginView,
  PLUGIN_VIEW_TYPE,
  PRINCIPAL_HEADER,
  signPrincipal,
} from '@orderloop/core';
import { pluginContract } from '@orderloop/plugin-sdk/contract';
import { expect, it } from 'vitest';
import ExamplePlugin from '../src/index';

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

it('keeps the plugin contract', async () => {
  const plugin = new ExamplePlugin({ waitUntil() {}, passThroughOnException() {} } as never, env);
  expect(
    await pluginContract(plugin, {
      effects: (orderId) => count('SELECT count(*) AS n FROM stamps WHERE order_id = ?', orderId),
      deliveries: (id) => count('SELECT count(*) AS n FROM deliveries WHERE id = ?', id),
      principalKey: 'example-test-key',
      noEffects: ['example.probe'],
    }),
  ).toEqual([]);
});

it('lets its public ping authenticate callers with its own secret', async () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const ping = (plugin: InstanceType<typeof ExamplePlugin>, auth?: string) =>
    plugin.fetch(
      new Request('https://app.test/plugins/example/public/ping', {
        headers: auth ? { authorization: auth } : {},
      }),
    );
  expect((await ping(new ExamplePlugin(ctx, env))).status).toBe(200);
  const guarded = new ExamplePlugin(ctx, { ...env, PING_TOKEN: 't0ken' });
  expect((await ping(guarded)).status).toBe(401);
  expect((await ping(guarded, 'Bearer t0ken')).status).toBe(200);
});

it('answers its page with a view of who is signed in', async () => {
  const plugin = new ExamplePlugin({ waitUntil() {}, passThroughOnException() {} } as never, env);
  const path = '/plugins/example/';
  const header = await signPrincipal(
    'example-test-key',
    { kind: 'user', id: 'usr_ada', name: 'Ada', role: 'operator' },
    path,
  );
  const res = await plugin.fetch(
    new Request(`https://app.test${path}`, { headers: { [PRINCIPAL_HEADER]: header } }),
  );
  expect(res.headers.get('content-type')).toBe(PLUGIN_VIEW_TYPE);
  expect(checkPluginView(await res.text())).toMatchObject({
    ok: true,
    view: {
      title: 'Example',
      blocks: [
        {
          type: 'stats',
          items: [
            { label: 'Signed in as', value: 'Ada' },
            { label: 'Role', value: 'operator' },
          ],
        },
        { type: 'code', text: 'usr_ada' },
      ],
    },
  });
});
