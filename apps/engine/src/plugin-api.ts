/**
 * PluginHost: what a plugin can ask of the core (`PluginHostRpc`), bound into each plugin as
 * `ORDERLOOP`: a service binding to this entrypoint for a Worker plugin, `ctx.exports` for a
 * sandboxed one. Who is calling is the binding's `props.id`, set by fleet rendering or the sandbox
 * loader, never an argument. Each method needs its capability declared and granted (`mayUse`), and
 * a plugin reaches only the carts it opened and orders under its own keys.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  type ExternalCartInput,
  type PluginCapability,
  type PluginCart,
  type PluginHostRpc,
  type PluginStartOrder,
  pluginOrderKey,
  startOrderSchema,
} from '@orderloop/core';
import { openExternalCart, pluginCart } from './cart/carts';
import { startOrderOnce } from './orders';
import { mayUse } from './plugins';

export class PluginHost extends WorkerEntrypoint<Env, { id: string }> implements PluginHostRpc {
  private async allowed(capability: PluginCapability): Promise<string | null> {
    const id = this.ctx.props?.id;
    if (!id) return null;
    return (await mayUse(this.env, id, capability)) ? id : null;
  }

  async openExternalCart(input: ExternalCartInput) {
    const id = await this.allowed('carts:external');
    if (!id) return { ok: false as const, error: 'This plugin may not open carts here.' };
    return openExternalCart(this.env, id, input);
  }

  async getCart(cartId: string): Promise<PluginCart | null> {
    const id = await this.allowed('carts:external');
    return id ? pluginCart(this.env, id, cartId) : null;
  }

  async startOrder(req: PluginStartOrder) {
    const id = await this.allowed('orders:start');
    if (!id) return { ok: false as const, error: 'This plugin may not start orders here.' };
    if (typeof req?.key !== 'string' || !req.key || req.key.length > 200)
      return { ok: false as const, error: 'key is 1 to 200 characters' };
    const parsed = startOrderSchema.safeParse({ flowId: req.flowId, input: req.input });
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]!.message };
    const input = parsed.data.input;
    try {
      const started = await startOrderOnce(this.env, {
        flowId: parsed.data.flowId,
        idempotencyKey: pluginOrderKey(id, req.key),
        startedBy: `plugin:${id}`,
        // Which plugin started it is the host's to say.
        input: { ...input, meta: { ...input.meta, plugin: { id, key: req.key } } },
      });
      if ('mismatch' in started)
        return { ok: false as const, error: 'That key already started a different order.' };
      return { ok: true as const, orderId: started.orderId, replayed: !!started.replayed };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
