/**
 * The RPC surface the web app reaches through its service binding. The web app has already
 * authorized the caller; this layer trusts it.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  CopilotRequest,
  CopilotResult,
  EngineRpc,
  OrderState,
  StartOrderInput,
  StartOrderOnceInput,
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
    return this.agent(orderId).deliver(event, payload ?? {});
  }

  async decide(
    orderId: string,
    nodeId: string,
    decision: 'approved' | 'rejected',
    by: string,
    note?: string,
  ) {
    await this.agent(orderId).decide(nodeId, decision, by, note);
  }

  async cancel(orderId: string, reason: string) {
    await this.agent(orderId).cancel(reason);
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
}
