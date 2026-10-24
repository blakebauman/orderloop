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
  capabilities: Record<string, unknown> = {},
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
    // Mcp-Name is the tool or prompt name, or the resource's uri.
    const named = params.name ?? params.uri;
    if (typeof named === 'string') headers.set('mcp-name', named);
    body = {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': revision,
        'io.modelcontextprotocol/clientCapabilities': capabilities,
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

  it('asks the person through a client that elicits, and acts once they agree', async () => {
    const orderId = await waitingOrder();
    const approver = person('approver', 'ann@example.com');
    const decide = { orderId, decision: 'approved' };
    const elicits = { elicitation: { form: {} } };
    const ask = async (extra: Record<string, unknown> = {}, args = decide) =>
      (
        (await rpc(
          approver,
          'tools/call',
          { name: 'decide_approval', arguments: args, ...extra },
          '2026-07-28',
          elicits,
        )) as { body: { result: Record<string, unknown> } }
      ).body.result;
    const waiting = async () => (await state(orderId)).waits.some((w) => w.kind === 'approval');

    // The first call asks; the model gets no code to send back itself.
    const first = await ask();
    expect(first).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        confirm: { method: 'elicitation/create', params: { message: expect.any(String) } },
      },
    });
    expect(JSON.stringify(first.inputRequests)).not.toContain('cfm_');
    expect(JSON.stringify(first.inputRequests)).toContain(
      'OrderLoop asks you to confirm: Decide an approval.',
    );
    const requestState = first.requestState as string;
    expect(await waiting()).toBe(true);

    const accept = { confirm: { action: 'accept', content: { confirm: true } } };
    // A no is final: the same state can't be accepted afterwards.
    expect(
      (await ask({ requestState, inputResponses: { confirm: { action: 'decline' } } })).isError,
    ).toBe(true);
    expect((await ask({ requestState, inputResponses: accept })).isError).toBe(true);
    expect(await waiting()).toBe(true);

    const second = (await ask()).requestState as string;
    // The state is not a code the model could send itself, on this client or as the argument.
    expect((await ask({}, { ...decide, confirmation: second } as typeof decide)).isError).toBe(
      true,
    );
    expect(
      (await call(approver, 'decide_approval', { ...decide, confirmation: second })).isError,
    ).toBe(true);
    // And a two-call code is not a request state.
    const code = (await call(approver, 'decide_approval', decide)).structuredContent!
      .confirmation as string;
    expect((await ask({ requestState: code, inputResponses: accept })).isError).toBe(true);
    // Forged, someone else's, or for another input: nothing happens.
    expect((await ask({ requestState: 'cfm_nope', inputResponses: accept })).isError).toBe(true);
    const bob = await rpc(
      person('approver', 'bob@example.com'),
      'tools/call',
      {
        name: 'decide_approval',
        arguments: decide,
        requestState: second,
        inputResponses: accept,
      },
      '2026-07-28',
      elicits,
    );
    expect((bob.body as { result: { isError?: boolean } }).result.isError).toBe(true);
    expect(
      (
        await ask(
          { requestState: second, inputResponses: accept },
          { ...decide, decision: 'rejected' },
        )
      ).isError,
    ).toBe(true);
    expect(await waiting()).toBe(true);

    const done = await ask({ requestState: second, inputResponses: accept });
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ done: expect.any(String) });
    // Once.
    expect((await ask({ requestState: second, inputResponses: accept })).isError).toBe(true);
    await until(async () => !(await waiting()), 'the decision');
    expect(JSON.stringify(await state(orderId))).toContain('ann@example.com via MCP');
  });

  it('falls back to the code on a 2026-07-28 client that cannot elicit', async () => {
    const orderId = await waitingOrder();
    const first = await call(
      person('approver', 'ann@example.com'),
      'decide_approval',
      { orderId, decision: 'approved' },
      '2026-07-28',
    );
    expect(first.structuredContent).toMatchObject({
      confirmation: expect.stringMatching(/^cfm_/),
    });
  });

  it('serves the skills a role can follow, with the Skills extension', async () => {
    const viewer = person('viewer', 'vic@example.com');
    const operator = person('operator', 'ops@example.com');
    const modern = async (p: Principal, method: string, params: Record<string, unknown> = {}) =>
      (await rpc(p, method, params, '2026-07-28')).body as {
        result?: Record<string, unknown>;
        error?: { code: number };
      };

    expect((await modern(viewer, 'server/discover')).result).toMatchObject({
      capabilities: {
        resources: {},
        extensions: { 'io.modelcontextprotocol/skills': {} },
      },
    });

    type Entry = {
      uri: string;
      frontmatter: { name: string };
      resources: { uri: string; digest: string; size: number }[];
    };
    const names = async (p: Principal) =>
      ((await modern(p, 'skills/list')).result!.skills as Entry[]).map((e) => e.frontmatter.name);
    expect(await names(viewer)).toEqual(['triage-attention']);
    expect((await names(operator)).sort()).toEqual([
      'change-a-flow',
      'review-approval',
      'stock-review',
      'triage-attention',
    ]);

    const listed = await modern(viewer, 'skills/list');
    expect(listed.result).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
    const [entry] = listed.result!.skills as Entry[];
    expect(entry).toMatchObject({ uri: 'skill://triage-attention/SKILL.md' });
    const [file] = entry!.resources;

    // The bytes served are the ones the manifest's digest and size describe.
    const read = await modern(viewer, 'resources/read', { uri: file!.uri });
    const text = (read.result!.contents as { text: string }[])[0]!.text;
    const bytes = new TextEncoder().encode(text);
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    expect(file!.digest).toBe(`sha256:${hex}`);
    expect(file!.size).toBe(bytes.length);
    expect(text).toContain('needs_attention');

    // A viewer is not served an operator's skill, listed or not.
    const unknown = { uri: 'skill://stock-review/SKILL.md' };
    expect((await modern(viewer, 'skills/get', unknown)).error).toMatchObject({ code: -32602 });
    expect((await modern(operator, 'skills/get', unknown)).result).toMatchObject({
      skill: { frontmatter: { name: 'stock-review' } },
    });
    expect((await modern(viewer, 'resources/read', unknown)).error).toBeDefined();
  });
});
