import { env } from 'cloudflare:workers';
import { pluginContract } from '@orderloop/plugin-sdk/contract';
import { expect, it } from 'vitest';
import FixtureCarrier from '../src/index';

it('keeps the plugin contract', async () => {
  const plugin = new FixtureCarrier({ waitUntil() {}, passThroughOnException() {} } as never, env);
  expect(
    await pluginContract(plugin, {
      effects: async (orderId) =>
        (await env.DB.prepare('SELECT count(*) AS n FROM labels WHERE order_id = ? AND voided = 0')
          .bind(orderId)
          .first<{ n: number }>())!.n,
    }),
  ).toEqual([]);
});
