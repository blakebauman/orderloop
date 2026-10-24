import { env } from 'cloudflare:workers';
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
    }),
  ).toEqual([]);
});
