import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  type Principal,
} from '@orderloop/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { startOrder } from '../src/orders';
import { signed } from './principal';

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
/** The revisions served: 2026-07-28 (envelope, no handshake) and the 2025 ones, statelessly. */
type Revision = '2026-07-28' | '2025-11-25' | '2025-06-18';

/** One JSON-RPC call to /mcp as the web Worker forwards it. */
async function rpc(
  p: Principal | null,
  method: string,
  params: Record<string, unknown> = {},
  revision: Revision = '2025-06-18',
) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': revision,
  });
  let body = params;
  if (revision === '2026-07-28') {
    // Each request names itself in headers and carries the client in `_meta`.
    headers.set('mcp-method', method);
    if (typeof params.name === 'string') headers.set('mcp-name', params.name);
    body = {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': revision,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
      },
    };
  }
  if (p) headers.set(PRINCIPAL_HEADER, await signed(p, '/mcp'));
  const res = await worker.fetch(
    new Request('https://engine/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params: body }),
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

const call = async (
  p: Principal,
  name: string,
  args: Record<string, unknown>,
  revision?: Revision,
) => {
  const r = await rpc(p, 'tools/call', { name, arguments: args }, revision);
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

  it('serves 2026-07-28 without a handshake, and the 2025 revisions statelessly', async () => {
    const viewer = person('viewer', 'vic@example.com');
    const discovered = await rpc(viewer, 'server/discover', {}, '2026-07-28');
    expect(discovered.status).toBe(200);
    expect(discovered.body).toMatchObject({
      result: {
        resultType: 'complete',
        capabilities: { tools: {} },
      },
    });
    for (const revision of ['2026-07-28', '2025-11-25', '2025-06-18'] as const) {
      const listed = await rpc(viewer, 'tools/list', {}, revision);
      expect(listed.status, revision).toBe(200);
      expect((listed.body as { result: { tools: unknown[] } }).result.tools, revision).toHaveLength(
        7,
      );
    }
    // Per role, so per client: 2026-07-28 says how long a client may keep the list.
    expect((await rpc(viewer, 'tools/list', {}, '2026-07-28')).body).toMatchObject({
      result: { ttlMs: 60_000, cacheScope: 'private' },
    });
    const res = await worker.fetch(
      new Request('https://engine/mcp', {
        headers: { [PRINCIPAL_HEADER]: await signed(viewer, '/mcp') },
      }),
      env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    // The SDK answers the transport errors itself.
    const headers = {
      [PRINCIPAL_HEADER]: await signed(viewer, '/mcp'),
      accept: 'application/json, text/event-stream',
    };
    const plain = await worker.fetch(
      new Request('https://engine/mcp', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: '{}',
      }),
      env,
    );
    expect(plain.status).toBe(415);
    const mismatch = await worker.fetch(
      new Request('https://engine/mcp', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'find_orders',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++n,
          method: 'tools/call',
          params: {
            name: 'get_order',
            arguments: { orderId: 'ord_x' },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
            },
          },
        }),
      }),
      env,
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: -32020 } });
  });

  it('lists only the tools the role can use, with hints', async () => {
    const tools = async (p: Principal) =>
      ((await rpc(p, 'tools/list')).body as { result: { tools: Record<string, unknown>[] } }).result
        .tools;
    const viewer = await tools(person('viewer', 'vic@example.com'));
    expect(viewer.map((t) => t.name).sort()).toEqual([
      'assess_order',
      'find_orders',
      'find_products',
      'get_flow',
      'get_order',
      'list_flows',
      'needs_attention',
    ]);
    expect(viewer.find((t) => t.name === 'find_orders')).toMatchObject({
      title: 'Find orders',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { count: {}, orders: {} } },
    });
    expect(viewer.every((t) => t.outputSchema)).toBe(true);
    const operator = await tools(person('operator', 'ops@example.com'));
    expect(operator).toHaveLength(13);
    expect(operator.find((t) => t.name === 'cancel_order')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    });
    expect(operator.find((t) => t.name === 'publish_flow')).toMatchObject({
      annotations: { openWorldHint: false },
    });
  });

  it('keeps an internal error to itself', async () => {
    await env.DB.prepare(
      "INSERT INTO flows (id, name, model, graph_json, created_at, updated_at) VALUES ('flw_broken', 'Broken', 'b2c', '{not json', 0, 0)",
    ).run();
    const broken = await call(person('viewer', 'vic@example.com'), 'get_flow', {
      flowId: 'flw_broken',
    });
    expect(broken.isError).toBe(true);
    expect(broken.content[0]!.text).toMatch(/went wrong on OrderLoop/);
    expect(broken.content[0]!.text).not.toMatch(/JSON/);
  });

  it('reads with structured content, and acts as the person via MCP', async () => {
    const orderId = await waitingOrder();
    const viewer = person('viewer', 'vic@example.com');

    const found = await call(viewer, 'get_order', { orderId });
    expect(found.isError).toBeFalsy();
    expect(found.structuredContent).toMatchObject({ id: orderId });
    const modern = await call(viewer, 'get_order', { orderId }, '2026-07-28');
    expect(modern).toMatchObject({ resultType: 'complete', structuredContent: { id: orderId } });

    const assessed = await call(viewer, 'assess_order', {
      orderId,
      questions: {
        next: {
          type: 'choice',
          instructions: 'What should happen next?',
          criteria: { approve: null, hold: null },
        },
      },
      images: ['orders/ord_someone_else/x.png'],
    });
    expect(assessed.isError).toBeFalsy();
    expect(assessed.structuredContent).toMatchObject({
      id: orderId,
      answers: { next: { type: 'choice', choice: 'approve' } },
      images: 0,
      source: 'heuristic',
    });
    expect((assessed.structuredContent!.notes as string[])[0]).toMatch(/not one of this order/);

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

    // An action's first call previews it and changes nothing.
    const approver = person('approver', 'ann@example.com');
    const decide = { orderId, decision: 'approved' };
    const first = await call(approver, 'decide_approval', decide);
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      preview: { title: expect.any(String) },
      confirmation: expect.stringMatching(/^cfm_[0-9a-f]{32}$/),
    });
    expect((await state(orderId)).waits.some((w) => w.kind === 'approval')).toBe(true);
    const code = first.structuredContent!.confirmation as string;

    // The code is for this person and this input only.
    const someoneElse = person('approver', 'bob@example.com');
    expect(
      (await call(someoneElse, 'decide_approval', { ...decide, confirmation: code })).isError,
    ).toBe(true);
    expect(
      (
        await call(approver, 'decide_approval', {
          ...decide,
          decision: 'rejected',
          confirmation: code,
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call(approver, 'decide_approval', { ...decide, confirmation: 'cfm_nope' })).isError,
    ).toBe(true);
    expect((await state(orderId)).waits.some((w) => w.kind === 'approval')).toBe(true);

    const done = await call(approver, 'decide_approval', { ...decide, confirmation: code });
    expect(done.isError).toBeFalsy();
    // Once.
    expect(
      (await call(approver, 'decide_approval', { ...decide, confirmation: code })).isError,
    ).toBe(true);
    const s = await until(async () => {
      const s = await state(orderId);
      return s.waits.some((w) => w.kind === 'approval') ? false : s;
    }, 'the decision');
    expect(JSON.stringify(s)).toContain('ann@example.com via MCP');
  });
});
