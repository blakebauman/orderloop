import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { AgentCard } from '@a2a-js/sdk';
import {
  agentCard,
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

async function fastWorkflows() {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}

/** A B2B order over its credit limit: it stops at the sales approval. */
const b2b: OrderInput = {
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId: 'cus_contoso',
  lines: [{ sku: 'WID-200', qty: 100 }],
  meta: {},
};

async function waitingOrder() {
  await fastWorkflows();
  const { orderId } = await startOrder(env, { flowId: 'tpl-b2b-order', input: b2b });
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

type Json = Record<string, any>;

let n = 0;
/** One JSON-RPC call to /a2a as the web Worker forwards it. */
async function rpc(p: Principal | null, method: string, params: Json = {}, version = '1.0') {
  const headers = new Headers({ 'content-type': 'application/json', 'a2a-version': version });
  if (p) headers.set(PRINCIPAL_HEADER, encodePrincipal(p));
  return worker.fetch(
    new Request('https://engine/a2a', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
    }),
    env,
  );
}

const call = async (p: Principal, method: string, params: Json) =>
  (await (await rpc(p, method, params)).json()) as { result?: Json; error?: Json };

let m = 0;
const message = (parts: Json[], extra: Json = {}) => ({
  message: { messageId: `msg-${++m}-${Date.now()}`, role: 'ROLE_USER', parts, ...extra },
});

/** SendMessage, returning the task. */
async function send(p: Principal, parts: Json[], extra: Json = {}) {
  const r = await call(p, 'SendMessage', message(parts, extra));
  if (!r.result?.task) throw new Error(`No task: ${JSON.stringify(r)}`);
  return r.result.task as Json;
}

const statusText = (t: Json) =>
  (t.status?.message?.parts ?? []).map((x: Json) => x.text ?? '').join('');

describe('A2A', () => {
  it('publishes a card the SDK reads as A2A 1.0', () => {
    const card = AgentCard.fromJSON(agentCard('https://app.test'));
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: 'https://app.test/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    });
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.skills.map((s) => s.id)).toEqual(
      expect.arrayContaining(['chat', 'place_order', 'find_orders', 'decide_approval']),
    );
    expect(Object.keys(card.securitySchemes)).toEqual(['apiToken', 'oauth']);
  });

  it('refuses a request the web Worker did not forward, and versions it does not speak', async () => {
    expect((await rpc(null, 'GetTask', { id: 'x' })).status).toBe(401);
    const old = (await (
      await rpc(person('viewer', 'v@example.com'), 'GetTask', { id: 'x' }, '0.3')
    ).json()) as Json;
    expect(old.error).toBeDefined();
  });

  it('runs a typed skill as the caller, within their role', async () => {
    const viewer = person('viewer', 'vee@example.com');
    const found = await send(viewer, [{ data: { skill: 'find_orders', input: { limit: 1 } } }]);
    expect(found.status.state).toBe('TASK_STATE_COMPLETED');
    expect(found.artifacts[0].parts[0].data).toHaveProperty('orders');

    const refused = await send(viewer, [
      { data: { skill: 'cancel_order', input: { orderId: 'ord_x', reason: 'x' } } },
    ]);
    expect(refused.status.state).toBe('TASK_STATE_REJECTED');
    expect(statusText(refused)).toContain('Operator');
  });

  it('keeps each caller’s tasks to themselves', async () => {
    const mine = await send(person('viewer', 'own@example.com'), [
      { data: { skill: 'list_flows' } },
    ]);
    const theirs = await call(person('viewer', 'other@example.com'), 'GetTask', { id: mine.id });
    expect(theirs.error).toBeDefined();
    const back = await call(person('viewer', 'own@example.com'), 'GetTask', { id: mine.id });
    expect(back.result?.id).toBe(mine.id);
  });

  it('places an order once per message id and follows it to its approval', async () => {
    await fastWorkflows();
    const op = person('operator', 'opal@example.com');
    const params = message([
      { data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } } },
    ]);
    const first = (await call(op, 'SendMessage', params)).result!.task as Json;
    const orderId = first.artifacts[0].parts[0].data.orderId as string;
    expect(orderId).toMatch(/^ord_/);

    const again = (await call(op, 'SendMessage', params)).result!.task as Json;
    expect(again.artifacts[0].parts[0].data).toMatchObject({ orderId, replayed: true });

    // The task reads the order: it waits on the approval, saying how to reply.
    const waiting = await until(async () => {
      const t = (await call(op, 'GetTask', { id: first.id })).result!;
      return t.status.state === 'TASK_STATE_INPUT_REQUIRED' ? t : false;
    }, 'input-required');
    expect(statusText(waiting)).toContain('decision');

    // A reply on the order's own task decides its approval.
    const decided = await send(op, [{ data: { decision: 'approved' } }], {
      taskId: first.id,
      contextId: first.contextId,
    });
    expect(decided.status.state).not.toBe('TASK_STATE_REJECTED');
    await until(async () => {
      const s = await state(orderId);
      return s.waits.some((w) => w.kind === 'approval') ? false : s;
    }, 'the decision');
    expect(JSON.stringify(await state(orderId))).toContain('opal@example.com via A2A');
  });

  it('cancels the order when its task is cancelled', async () => {
    await fastWorkflows();
    const op = person('operator', 'oc@example.com');
    const placed = await send(op, [
      { data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } } },
    ]);
    const orderId = placed.artifacts[0].parts[0].data.orderId as string;
    await until(async () => {
      const s = await state(orderId);
      return s.waits.some((w) => w.kind === 'approval') ? s : false;
    }, 'the approval');

    const cancelled = await call(op, 'CancelTask', { id: placed.id });
    expect(cancelled.result?.status.state).toBe('TASK_STATE_CANCELED');
    const s = await until(async () => {
      const s = await state(orderId);
      return s.status === 'waiting' ? false : s;
    }, 'the cancel');
    expect(['cancelled', 'rolled_back']).toContain(s.status);
    expect(JSON.stringify(s)).toContain('oc@example.com via A2A');
  });

  it('refuses what live data does not allow', async () => {
    const orderId = await waitingOrder();
    const op = person('operator', 'od@example.com');
    const nothing = await send(op, [
      { data: { skill: 'deliver_event', input: { orderId, event: 'no.such.event' } } },
    ]);
    expect(nothing.status.state).toBe('TASK_STATE_REJECTED');
    expect(statusText(nothing)).toContain('no.such.event');
  });

  it('proposes actions in chat and runs them only when confirmed', async () => {
    const orderId = await waitingOrder();
    const ann = person('approver', 'chat@example.com');
    const ref = orderId.slice(-6);

    const declined = await send(ann, [{ text: `approve #${ref}` }]);
    expect(declined.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(declined.artifacts[0].parts[0].data).toMatchObject({ tool: 'decide_approval' });
    const left = await send(ann, [{ data: { confirm: false } }], {
      taskId: declined.id,
      contextId: declined.contextId,
    });
    expect(left.status.state).toBe('TASK_STATE_CANCELED');
    expect((await state(orderId)).waits.some((w) => w.kind === 'approval')).toBe(true);

    const proposed = await send(ann, [{ text: `approve #${ref}` }]);
    const confirmed = await send(ann, [{ data: { confirm: true } }], {
      taskId: proposed.id,
      contextId: proposed.contextId,
    });
    expect(confirmed.status.state).not.toBe('TASK_STATE_REJECTED');
    await until(async () => {
      const s = await state(orderId);
      return s.waits.some((w) => w.kind === 'approval') ? false : s;
    }, 'the decision');
    expect(JSON.stringify(await state(orderId))).toContain('chat@example.com via A2A');
  });

  it('streams status updates over SSE', async () => {
    const res = await rpc(
      person('viewer', 'sse@example.com'),
      'SendStreamingMessage',
      message([{ data: { skill: 'list_flows' } }]),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as Json);
    const states = events.map((e) => e.result?.statusUpdate?.status?.state).filter(Boolean);
    expect(states).toContain('TASK_STATE_WORKING');
    expect(states.at(-1)).toBe('TASK_STATE_COMPLETED');
  });

  it('streams a reply on an existing task, starting with the task', async () => {
    await fastWorkflows();
    const op2 = person('operator', 'sr2@example.com');
    const first = await send(op2, [
      { data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } } },
    ]);
    await until(async () => {
      const t = (await call(op2, 'GetTask', { id: first.id })).result!;
      return t.status.state === 'TASK_STATE_INPUT_REQUIRED' ? t : false;
    }, 'input-required');
    const res = await rpc(
      op2,
      'SendStreamingMessage',
      message([{ data: { decision: 'approved' } }], {
        taskId: first.id,
        contextId: first.contextId,
      }),
    );
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as Json);
    expect(events[0]?.result?.task?.id).toBe(first.id);
    // The approval it just gave is not reported back as still waiting.
    const waits = events
      .map((e) => e.result?.statusUpdate?.status)
      .filter((st) => st?.state === 'TASK_STATE_INPUT_REQUIRED');
    expect(JSON.stringify(waits)).not.toContain('"nodeId": "approval"');
    expect(events.some((e) => e.result?.statusUpdate)).toBe(true);
    expect(events.every((e) => !e.error)).toBe(true);
  });
});
