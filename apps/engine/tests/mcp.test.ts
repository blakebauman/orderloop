import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  encodePrincipal,
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  type Principal,
} from '@orderloop/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { startOrder } from '../src/orders';

const state = async (id: string) => (await env.ORDER_AGENT.getByName(id).snapshot()) as OrderState;

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

/** A B2B order over its credit limit, waiting on the sales approval. */
async function waitingOrder() {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const input: OrderInput = {
    model: 'b2b',
    channel: 'api',
    currency: 'USD',
    customerId: 'cus_contoso',
    lines: [{ sku: 'WID-200', qty: 100 }],
    meta: {},
  };
  const { orderId } = await startOrder(env, { flowId: 'tpl-b2b-order', input });
  await until(async () => {
    const s = await state(orderId);
    return s.waits.some((w) => w.kind === 'approval') ? s : false;
  }, 'the approval');
  return orderId;
}

const person = (role: Principal['role'], email: string): Principal => ({
  kind: 'user',
  id: `usr_${email.split('@')[0]}`,
  name: email.split('@')[0]!,
  email,
  role,
});

let n = 0;
/** One JSON-RPC call to /mcp as the web Worker forwards it (2025-06-18 stateless lane). */
async function rpc(p: Principal | null, method: string, params: Record<string, unknown> = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  });
  if (p) headers.set(PRINCIPAL_HEADER, encodePrincipal(p));
  const res = await worker.fetch(
    new Request('https://engine/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
    }),
    env,
  );
  if (res.status !== 200) return { status: res.status, body: await res.text() };
  const text = await res.text();
  // A streamed reply carries the JSON-RPC message on an SSE `data:` line.
  const json = text.startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5),
      );
  return { status: 200, body: json as { result?: Record<string, unknown>; error?: unknown } };
}

const call = async (p: Principal, name: string, args: Record<string, unknown>) => {
  const r = await rpc(p, 'tools/call', { name, arguments: args });
  return (r.body as { result: Record<string, unknown> }).result as {
    content: { text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

describe('MCP', () => {
  it('refuses a request the web Worker did not forward', async () => {
    expect((await rpc(null, 'tools/list')).status).toBe(401);
  });

  it('lists only the tools the role can use, with hints', async () => {
    const tools = async (p: Principal) =>
      ((await rpc(p, 'tools/list')).body as { result: { tools: Record<string, unknown>[] } }).result
        .tools;
    const viewer = await tools(person('viewer', 'vic@example.com'));
    expect(viewer.map((t) => t.name).sort()).toEqual([
      'find_orders',
      'find_products',
      'get_flow',
      'get_order',
      'list_flows',
      'needs_attention',
    ]);
    expect(viewer.find((t) => t.name === 'find_orders')).toMatchObject({
      title: 'Find orders',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object' },
    });
    const operator = await tools(person('operator', 'ops@example.com'));
    expect(operator).toHaveLength(12);
    expect(operator.find((t) => t.name === 'cancel_order')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  });

  it('reads with structured content, and acts as the person via MCP', async () => {
    const orderId = await waitingOrder();
    const viewer = person('viewer', 'vic@example.com');

    const found = await call(viewer, 'get_order', { orderId });
    expect(found.isError).toBeFalsy();
    expect(found.structuredContent).toMatchObject({ id: orderId });

    // Not offered to a viewer, so there is nothing to call.
    const refused = await rpc(viewer, 'tools/call', {
      name: 'cancel_order',
      arguments: { orderId, reason: 'x' },
    });
    expect(refused.body).toMatchObject({ error: { message: 'Tool cancel_order not found' } });

    // A refusal from live data comes back as a tool error the model can read.
    const op = person('operator', 'ops@example.com');
    const nothing = await call(op, 'deliver_event', { orderId, event: 'no.such.event' });
    expect(nothing.isError).toBe(true);

    const approver = person('approver', 'ann@example.com');
    const done = await call(approver, 'decide_approval', { orderId, decision: 'approved' });
    expect(done.isError).toBeFalsy();
    const s = await until(async () => {
      const s = await state(orderId);
      return s.waits.some((w) => w.kind === 'approval') ? false : s;
    }, 'the decision');
    expect(JSON.stringify(s)).toContain('ann@example.com via MCP');
  });
});
