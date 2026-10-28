/**
 * The RPC surface the web app reaches through its service binding. The web app has already
 * authorized the caller; this layer trusts it.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  atLeast,
  type CartAttachment,
  type CartOp,
  type CopilotRequest,
  type CopilotResult,
  type CreateCartInput,
  type EngineRpc,
  HEALTH_WRITE_PATH,
  healthReport,
  type OrderState,
  type PaymentEvent,
  type PluginCase,
  parseMailboxes,
  pluginBinding,
  runHealthChecks,
  type SignedActor,
  type StartOrderInput,
  type StartOrderOnceInput,
  type TaxCertificateInput,
  UCP_PATH,
  verifyHealthCheck,
} from '@orderloop/core';
import type { ProductDraftRequest } from '@orderloop/core/product';
import { createDb, orders, probeDb } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { A2A_PATH, a2aCaller, handleA2A } from './a2a/route';
import { routeAgents } from './agent-routes';
import { copilot } from './ai';
import { Refused } from './assistant/data';
import { draftProductContent } from './assistant/product-draft';
import {
  cancelCart,
  cartSnapshot,
  changeCart,
  createCart,
  keepCartOpen,
  redeemCartStart,
  submitCart,
} from './cart/carts';
import { searchCartProducts } from './cart/search';
import { probeBucket } from './health';
import { handleMcp, MCP_PATH } from './mcp';
import { a2aAgent, cartAgent, healthProbe, orderAgent } from './namespaces';
import { fromOutside, startOrder, startOrderOnce } from './orders';
import { handleStripeEvent } from './payment-events';
import { installedPlugins, pinnedManifest } from './plugin-host';
import * as installs from './plugin-installs';
import { manifests, plugin, pluginStatuses, pluginUsage } from './plugins';
import { rpcActor } from './principal';
import { reindexProducts } from './product-index';
import { separationRefusal } from './separation';
import { eraseDataSubject, exportDataSubject } from './subjects';
import {
  addTaxCertificate,
  listTaxCertificates,
  revokeTaxCertificate,
  verifyTaxCertificate,
} from './tax-certificates';
import { ucpProfile } from './ucp/config';
import { handleUcp } from './ucp/rest';

/** A binding call without an actor the web app signed for it. */
const UNSIGNED = { ok: false as const, error: 'This call must name who is acting.' };

export class EngineApi extends WorkerEntrypoint<Env> implements EngineRpc {
  /**
   * The web app proxies the agent WebSockets (`/agents/order-agent/:id`,
   * `/agents/assistant-agent/:id`), MCP (`/mcp`), A2A (`/a2a`) and UCP (`/ucp/*`) here.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-engine' });
    if (url.pathname === MCP_PATH) return handleMcp(request);
    if (url.pathname === A2A_PATH) return handleA2A(request, this.env);
    if (url.pathname === UCP_PATH || url.pathname.startsWith(`${UCP_PATH}/`))
      return handleUcp(request, this.env);
    return routeAgents(request, this.env);
  }

  private agent(orderId: string) {
    return orderAgent(this.env, orderId);
  }

  startOrder(input: StartOrderInput) {
    return startOrder(this.env, fromOutside(input));
  }

  startOrderOnce(input: StartOrderOnceInput) {
    return startOrderOnce(this.env, fromOutside(input));
  }

  async sendEvent(orderId: string, event: string, payload?: Record<string, unknown>) {
    if (!(await this.snapshot(orderId))) return { delivered: false, notFound: true as const };
    return this.agent(orderId).deliver(event, payload ?? {});
  }

  paymentEvent(event: PaymentEvent) {
    return handleStripeEvent(this.env, event);
  }

  async decide(
    orderId: string,
    nodeId: string,
    decision: 'approved' | 'rejected',
    signed: SignedActor,
    note?: string,
  ) {
    const actor = await rpcActor(this.env, signed, `decide:${orderId}`);
    if (actor?.kind !== 'staff')
      return { ok: false as const, reason: 'forbidden' as const, error: UNSIGNED.error };
    if (!atLeast(actor.role, 'approver'))
      return {
        ok: false as const,
        reason: 'forbidden' as const,
        error: 'This needs the Approver role.',
      };
    const { name: by, id: deciderId } = actor;
    const s = await this.snapshot(orderId);
    // An order recorded with no run behind it (imported, or written straight to D1) has an
    // approval row nothing will ever resume: say so, rather than that the order is gone.
    if (!s)
      return {
        ok: false as const,
        reason: (await this.recorded(orderId)) ? ('no_run' as const) : ('not_found' as const),
      };
    if (!s.waits.some((w) => w.kind === 'approval' && w.nodeId === nodeId))
      return { ok: false as const, reason: 'not_waiting' as const };
    const own = await separationRefusal(this.env, orderId, deciderId);
    if (own) return { ok: false as const, reason: 'own_order' as const, error: own };
    await this.agent(orderId).decide(nodeId, decision, by, note, deciderId);
    return { ok: true as const };
  }

  exportDataSubject(email: string) {
    return exportDataSubject(this.env, email);
  }

  eraseDataSubject(email: string) {
    return eraseDataSubject(this.env, email);
  }

  async cancel(orderId: string, reason: string) {
    if (!(await this.snapshot(orderId)))
      return { ok: false as const, reason: 'not_found' as const };
    const r = (await this.agent(orderId).cancel(reason)) as { ok: boolean };
    return r.ok ? { ok: true as const } : { ok: false as const, reason: 'finished' as const };
  }

  async intakeMailboxes() {
    return parseMailboxes(this.env.INTAKE_MAILBOXES);
  }

  /** Whether D1 has the order, whatever its agent holds. */
  private async recorded(orderId: string) {
    const row = await createDb(this.env.DB)
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();
    return !!row;
  }

  async snapshot(orderId: string): Promise<OrderState | null> {
    const s = (await this.agent(orderId).snapshot()) as OrderState;
    return s.orderId ? s : null;
  }

  copilot(req: CopilotRequest): Promise<CopilotResult> {
    return copilot(this.env, req);
  }

  async dropA2aPushes(kind: 'user' | 'token', id: string, grants: readonly string[] = []) {
    let configs = 0;
    for (const name of [
      a2aCaller({ kind, id }),
      ...grants.map((grant) => a2aCaller({ kind, id, grant })),
    ])
      configs += await a2aAgent(this.env, name).dropPushes();
    return { configs };
  }

  async runReplenish() {
    const instance = await this.env.REPLENISH.create({ params: {} });
    return { instanceId: instance.id };
  }

  async reindexProducts(signed: SignedActor) {
    const actor = await rpcActor(this.env, signed, 'reindex-products');
    if (actor?.kind !== 'staff') return UNSIGNED;
    if (!atLeast(actor.role, 'admin'))
      return { ok: false as const, error: 'This needs the Admin role.' };
    return { ok: true as const, value: await reindexProducts(this.env) };
  }

  async draftProductContent(key: string, request: ProductDraftRequest, signed: SignedActor) {
    const actor = await rpcActor(this.env, signed, `draft-product:${key}`);
    if (actor?.kind !== 'staff') return UNSIGNED;
    if (!atLeast(actor.role, 'operator'))
      return { ok: false as const, error: 'This needs the Operator role.' };
    const p = { kind: 'user' as const, id: actor.id, name: actor.name, role: actor.role };
    try {
      const value = await draftProductContent(this.env, p, key, request ?? {});
      return { ok: true as const, value };
    } catch (err) {
      if (err instanceof Refused) return { ok: false as const, error: err.message };
      throw err;
    }
  }

  async health() {
    // Each installed plugin answers, just now, with a manifest the engine accepts.
    const statuses = await pluginStatuses(this.env, true);
    const plugins = Object.fromEntries(
      statuses.map((p) => [
        pluginBinding(p.id).toLowerCase(),
        async () => {
          if (!p.healthy) throw new Error(p.error);
        },
      ]),
    );
    return runHealthChecks('orderloop-engine', {
      db: () => this.env.DB.prepare('select 1').first(),
      docs: () => this.env.DOCS.head('health'),
      ...plugins,
    });
  }

  async writeHealth(signed: string) {
    // Only CI can sign the check (from the principal key the two Workers share), so a caller
    // without it costs no writes; refused, it also shows the web app and engine disagree on keys.
    const keys = [this.env.PRINCIPAL_KEY, this.env.PRINCIPAL_KEY_PREVIOUS];
    if (!(await verifyHealthCheck(keys, signed, HEALTH_WRITE_PATH)))
      return healthReport('orderloop-engine', { signature: 'fail' });
    const id = `engine-${crypto.randomUUID()}`;
    return runHealthChecks('orderloop-engine', {
      db: () => probeDb(createDb(this.env.DB), id),
      docs: () => probeBucket(this.env.DOCS, id),
      objects: () => healthProbe(this.env).probe(id),
    });
  }

  ucpProfile(origin: string) {
    return ucpProfile(this.env, origin);
  }

  pluginCatalog() {
    return pluginStatuses(this.env);
  }

  pluginUsage(id: string) {
    return pluginUsage(this.env, id);
  }

  listPluginInstalls() {
    return installs.listPluginInstalls(this.env);
  }

  pluginPublishers() {
    return Promise.resolve(installs.publisherNames(this.env));
  }

  uploadPlugin(bundle: string, by: string) {
    return installs.refusable(() => installs.uploadPlugin(this.env, bundle, by));
  }

  approvePlugin(id: string, sha: string, grant: { personalData: boolean }, by: string) {
    return installs.refusable(() => installs.approvePlugin(this.env, id, sha, grant, by));
  }

  setPluginSecret(id: string, name: string, value: string, by: string) {
    return installs.refusable(() => installs.setPluginSecret(this.env, id, name, value, by));
  }

  setPluginEnabled(id: string, enabled: boolean) {
    return installs.refusable(() => installs.setPluginEnabled(this.env, id, enabled));
  }

  rollbackPlugin(id: string, sha: string) {
    return installs.refusable(() => installs.rollbackPlugin(this.env, id, sha));
  }

  uninstallPlugin(id: string) {
    return installs.refusable(() => installs.uninstallPlugin(this.env, id));
  }

  runPluginCases(id: string, sha: string, cases: PluginCase[], _by: string) {
    return installs.refusable(() => installs.runPluginCases(this.env, id, sha, cases));
  }

  async pluginFetch(id: string, request: Request) {
    // Only a sandboxed plugin's pages come this way; a Worker plugin's the web app reaches itself.
    if (!(await installedPlugins(this.env)).some((p) => p.id === id && p.runtime === 'sandboxed'))
      return new Response('Not found', { status: 404 });
    await manifests(this.env);
    // Only a plugin whose pinned manifest has pages: one without (an assistant draft's rules, say)
    // serves none, whatever its code answers.
    const m = await pinnedManifest(this.env, id);
    if (!m || (!m.nav.length && !m.publicPaths.length))
      return new Response('Not found', { status: 404 });
    const stub = await plugin(this.env, id, 'serve');
    if (!stub) return new Response('Not found', { status: 404 });
    return stub.fetch(request);
  }

  createCart(input: CreateCartInput) {
    return createCart(this.env, input);
  }

  cartSnapshot(id: string) {
    return cartSnapshot(this.env, id);
  }

  async changeCart(cartId: string, op: CartOp, signed: SignedActor) {
    const actor = await this.cartActor(cartId, signed);
    return actor?.kind === 'staff' ? changeCart(this.env, cartId, op, actor) : UNSIGNED;
  }

  async submitCart(cartId: string, signed: SignedActor, version?: number) {
    const actor = await this.cartActor(cartId, signed);
    return actor?.kind === 'staff' ? submitCart(this.env, cartId, actor, version) : UNSIGNED;
  }

  async cancelCart(cartId: string, signed: SignedActor) {
    const actor = await this.cartActor(cartId, signed);
    return actor?.kind === 'staff' ? cancelCart(this.env, cartId, actor) : UNSIGNED;
  }

  /** Who the web app signed this cart call for: never a caller's own say. */
  private cartActor(cartId: string, signed: SignedActor) {
    return rpcActor(this.env, signed, `cart:${cartId}`);
  }

  redeemCartStart(cartId: string, token: string) {
    return redeemCartStart(this.env, cartId, token);
  }

  async attachToCart(
    cartId: string,
    attachment: Omit<CartAttachment, 'by' | 'at'>,
    signed: SignedActor,
  ) {
    const actor = await this.cartActor(cartId, signed);
    if (!actor) return UNSIGNED;
    if (!(await cartSnapshot(this.env, cartId)))
      return { ok: false as const, error: 'No such cart.' };
    return cartAgent(this.env, cartId).attachAs(actor, attachment);
  }

  async searchCartProducts(cartId: string, q: string, signed: SignedActor) {
    const actor = await this.cartActor(cartId, signed);
    if (!actor) return UNSIGNED;
    const page = await searchCartProducts(this.env, cartId, actor, typeof q === 'string' ? q : '');
    if (page.ok) await cartAgent(this.env, cartId).keepOpenFor(actor);
    return page;
  }

  async keepCartOpen(cartId: string, signed: SignedActor) {
    const actor = await this.cartActor(cartId, signed);
    if (actor) await keepCartOpen(this.env, cartId, actor);
  }

  taxCertificates(customerId: string) {
    return listTaxCertificates(this.env, customerId);
  }

  async addTaxCertificate(customerId: string, input: TaxCertificateInput, signed: SignedActor) {
    const actor = await this.certificateActor(customerId, signed);
    return 'error' in actor ? actor : addTaxCertificate(this.env, customerId, input, actor);
  }

  async verifyTaxCertificate(customerId: string, id: string, signed: SignedActor) {
    const actor = await this.certificateActor(customerId, signed);
    return 'error' in actor ? actor : verifyTaxCertificate(this.env, customerId, id, actor);
  }

  async revokeTaxCertificate(customerId: string, id: string, signed: SignedActor) {
    const actor = await this.certificateActor(customerId, signed);
    return 'error' in actor ? actor : revokeTaxCertificate(this.env, customerId, id, actor);
  }

  /** Staff, Operator or above, signed for this customer's certificates; else why not. */
  private async certificateActor(customerId: string, signed: SignedActor) {
    const actor = await rpcActor(this.env, signed, `tax-certificates:${customerId}`);
    if (actor?.kind !== 'staff') return UNSIGNED;
    if (!atLeast(actor.role, 'operator'))
      return { ok: false as const, error: 'This needs the Operator role.' };
    return actor;
  }
}
