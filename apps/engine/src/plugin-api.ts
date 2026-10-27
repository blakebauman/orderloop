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
  type OrderState,
  type PluginCapability,
  type PluginCart,
  type PluginHostRpc,
  type PluginStartOrder,
  pluginOrderKey,
  startOrderSchema,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import { createDb, fxRates, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { recordAudit } from './audit';
import { checkExternalCart, openExternalCart, pluginCart } from './cart/carts';
import { orderAgent } from './namespaces';
import { startOrderOnce } from './orders';
import { mayUse } from './plugins';

export class PluginHost extends WorkerEntrypoint<Env, { id: string }> implements PluginHostRpc {
  async #allowed(capability: PluginCapability): Promise<string | null> {
    const id = this.ctx.props?.id;
    if (!id) return null;
    return (await mayUse(this.env, id, capability)) ? id : null;
  }

  async openExternalCart(input: ExternalCartInput) {
    const id = await this.#allowed('carts:external');
    if (!id) return { ok: false as const, error: 'This plugin may not open carts here.' };
    return openExternalCart(this.env, id, input);
  }

  async checkExternalCart(input: ExternalCartInput) {
    const id = await this.#allowed('carts:external');
    if (!id) return { ok: false as const, error: 'This plugin may not open carts here.' };
    if (!input || typeof input !== 'object')
      return { ok: false as const, error: 'That is not a cart to check.' };
    return { ok: true as const, problems: await checkExternalCart(this.env, input) };
  }

  async getCart(cartId: string): Promise<PluginCart | null> {
    const id = await this.#allowed('carts:external');
    return id && typeof cartId === 'string' ? pluginCart(this.env, id, cartId) : null;
  }

  async orderStatus(req: { key: string }) {
    const id = await this.#allowed('orders:start');
    if (!id) return { ok: false as const, error: 'This plugin may not start orders here.' };
    if (typeof req?.key !== 'string' || !req.key || req.key.length > 200)
      return { ok: false as const, error: 'key is 1 to 200 characters' };
    const row = await this.#started(id, req.key);
    if (!row) return { ok: false as const, error: 'No order was started under that key.' };
    // The agent's, not the index row's, which can lag behind an order that just ended.
    const { status } = (await orderAgent(this.env, row.id).snapshot()) as OrderState;
    return {
      ok: true as const,
      orderId: row.id,
      status,
      ended: TERMINAL_ORDER_STATUSES.includes(status),
    };
  }

  /** The order this plugin started under `key`: its key is in this plugin's own namespace. */
  #started(id: string, key: string) {
    return createDb(this.env.DB)
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.idempotencyKey, pluginOrderKey(id, key)))
      .get();
  }

  async cancelOrder(req: { key: string; reason: string }) {
    const id = await this.#allowed('orders:cancel');
    if (!id) return { ok: false as const, error: 'This plugin may not cancel orders here.' };
    if (typeof req?.key !== 'string' || !req.key || req.key.length > 200)
      return { ok: false as const, error: 'key is 1 to 200 characters' };
    const reason = String(req.reason ?? '').slice(0, 500) || `Cancelled by ${id}`;
    const row = await this.#started(id, req.key);
    if (!row) return { ok: false as const, error: 'No order was started under that key.' };
    if (row.status === 'cancelled')
      return { ok: true as const, orderId: row.id, outcome: 'cancelled' as const };
    const agent = orderAgent(this.env, row.id);
    const r = (await agent.cancel(reason)) as { ok: boolean };
    if (r.ok) {
      await recordAudit(this.env, 'order.cancelled', {
        actor: { kind: 'plugin', id: `plugin:${id}`, name: id },
        target: row.id,
        detail: { reason, via: 'plugin' },
      });
      return { ok: true as const, orderId: row.id, outcome: 'cancelled' as const };
    }
    // Refused: a cancel already under way (the order is still live, and about to be cancelled), or
    // the order ended since the read above. Only one that ended some other way is finished.
    const { status } = (await agent.snapshot()) as OrderState;
    return {
      ok: true as const,
      orderId: row.id,
      outcome:
        status !== 'cancelled' && TERMINAL_ORDER_STATUSES.includes(status)
          ? ('finished' as const)
          : ('cancelled' as const),
    };
  }

  async startOrder(req: PluginStartOrder) {
    const id = await this.#allowed('orders:start');
    if (!id) return { ok: false as const, error: 'This plugin may not start orders here.' };
    if (typeof req?.key !== 'string' || !req.key || req.key.length > 200)
      return { ok: false as const, error: 'key is 1 to 200 characters' };
    const parsed = startOrderSchema.safeParse({ flowId: req.flowId, input: req.input });
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]!.message };
    const input = parsed.data.input;
    const rate = await createDb(this.env.DB)
      .select({ currency: fxRates.currency })
      .from(fxRates)
      .where(eq(fxRates.currency, input.currency))
      .get();
    if (!rate)
      return {
        ok: false as const,
        error: `Unsupported currency ${input.currency}; there is no exchange rate for it`,
      };
    // Keys the core gives meaning to are the core's to set: a plugin can't make its order look
    // like a UCP checkout's (whose platform would be sent it) or a cart's.
    const { ucp: _ucp, cart: _cart, plugin: _plugin, ...meta } = input.meta;
    try {
      const started = await startOrderOnce(this.env, {
        flowId: parsed.data.flowId,
        idempotencyKey: pluginOrderKey(id, req.key),
        startedBy: `plugin:${id}`,
        input: { ...input, meta: { ...meta, plugin: { id, key: req.key } } },
      });
      if ('mismatch' in started)
        return { ok: false as const, error: 'That key already started a different order.' };
      if (!started.replayed)
        await recordAudit(this.env, 'order.started', {
          actor: { kind: 'plugin', id: `plugin:${id}`, name: id },
          target: started.orderId,
          detail: { flowId: parsed.data.flowId, via: 'plugin' },
        });
      return { ok: true as const, orderId: started.orderId, replayed: !!started.replayed };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
