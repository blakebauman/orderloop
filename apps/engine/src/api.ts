/**
 * The RPC surface the web app reaches through its service binding. The web app has already
 * authorized the caller; this layer trusts it.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  type CopilotRequest,
  type CopilotResult,
  type EngineRpc,
  type OrderState,
  parseMailboxes,
  runHealthChecks,
  type StartOrderInput,
  type StartOrderOnceInput,
} from '@orderloop/core';
import { routeAgentRequest } from 'agents';
import { A2A_PATH, handleA2A } from './a2a/route';
import { copilot } from './ai';
import { handleMcp, MCP_PATH } from './mcp';
import { startOrder, startOrderOnce } from './orders';

export class EngineApi extends WorkerEntrypoint<Env> implements EngineRpc {
  /**
   * The web app proxies the agent WebSockets (`/agents/order-agent/:id`,
   * `/agents/assistant-agent/:id`), MCP (`/mcp`) and A2A (`/a2a`) here.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-engine' });
    if (url.pathname === MCP_PATH) return handleMcp(request);
    if (url.pathname === A2A_PATH) return handleA2A(request, this.env);
    return (
      (await routeAgentRequest(request, this.env)) ?? new Response('Not found', { status: 404 })
    );
  }

  private agent(orderId: string) {
    return this.env.ORDER_AGENT.getByName(orderId);
  }

  startOrder(input: StartOrderInput) {
    return startOrder(this.env, input);
  }

  startOrderOnce(input: StartOrderOnceInput) {
    return startOrderOnce(this.env, input);
  }

  async sendEvent(orderId: string, event: string, payload?: Record<string, unknown>) {
    if (!(await this.snapshot(orderId))) return { delivered: false, notFound: true as const };
    return this.agent(orderId).deliver(event, payload ?? {});
  }

  async decide(
    orderId: string,
    nodeId: string,
    decision: 'approved' | 'rejected',
    by: string,
    note?: string,
  ) {
    const s = await this.snapshot(orderId);
    if (!s) return { ok: false as const, reason: 'not_found' as const };
    if (!s.waits.some((w) => w.kind === 'approval' && w.nodeId === nodeId))
      return { ok: false as const, reason: 'not_waiting' as const };
    await this.agent(orderId).decide(nodeId, decision, by, note);
    return { ok: true as const };
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

  async snapshot(orderId: string): Promise<OrderState | null> {
    const s = (await this.agent(orderId).snapshot()) as OrderState;
    return s.orderId ? s : null;
  }

  copilot(req: CopilotRequest): Promise<CopilotResult> {
    return copilot(this.env, req);
  }

  async runReplenish() {
    const instance = await this.env.REPLENISH.create({ params: {} });
    return { instanceId: instance.id };
  }

  health() {
    return runHealthChecks('orderloop-engine', {
      db: () => this.env.DB.prepare('select 1').first(),
      docs: () => this.env.DOCS.head('health'),
    });
  }
}
