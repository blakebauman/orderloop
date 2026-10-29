import { introspectWorkflow, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { AgentCard } from '@a2a-js/sdk';
import {
  agentCard,
  isEncrypted,
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  type Principal,
} from '@orderloop/core';
import { createDb, users } from '@orderloop/db';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SqlPushStore } from '../src/a2a/push';
import { changeCart, createCart } from '../src/cart/carts';
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

// biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
type Json = Record<string, any>;

let n = 0;
/** One JSON-RPC call to /a2a as the web Worker forwards it. */
async function rpc(p: Principal | null, method: string, params: Json = {}, version = '1.0') {
  const headers = new Headers({ 'content-type': 'application/json', 'a2a-version': version });
  if (p) headers.set(PRINCIPAL_HEADER, await signed(p, '/a2a'));
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
    expect(card.capabilities?.pushNotifications).toBe(true);
    expect(card.skills.map((s) => s.id)).toEqual(
      expect.arrayContaining(['chat', 'place_order', 'find_orders', 'decide_approval']),
    );
    expect(Object.keys(card.securitySchemes)).toEqual(['apiToken', 'oauth']);
  });

  it('refuses a request the web Worker did not forward, and versions it does not speak', async () => {
    expect((await rpc(null, 'GetTask', { id: 'x' })).status).toBe(401);
    const old = (await (
      await rpc(person('viewer', 'v@example.com'), 'GetTask', { id: 'x' }, '2.0')
    ).json()) as Json;
    expect(old.error).toBeDefined();
  });

  it('runs a typed skill as the caller, within their role', async () => {
    const viewer = person('viewer', 'vee@example.com');
    const found = await send(viewer, [{ data: { skill: 'find_orders', input: { limit: 1 } } }]);
    expect(found.status.state).toBe('TASK_STATE_COMPLETED');
    expect(found.artifacts[0].parts[0].data).toHaveProperty('orders');

    const orderId = await waitingOrder();
    const assessed = await send(viewer, [
      {
        data: {
          skill: 'assess_order',
          input: { orderId, questions: { late: { type: 'noul', instructions: 'Is it late?' } } },
        },
      },
    ]);
    expect(assessed.status.state).toBe('TASK_STATE_COMPLETED');
    expect(assessed.artifacts[0].parts[0].data.answers).toEqual({
      late: { type: 'noul', noul: 0.5 },
    });

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

  it('keeps two apps one person connected apart, push credentials included', async () => {
    // Receivers that never answer, so configs stay put.
    const fetching = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('nope', { status: 500 }));
    onTestFinished(() => fetching.mockRestore());
    const me = person('viewer', 'two-apps@example.com');
    const appA = { ...me, grant: 'grant_a', client: 'client_a' };
    const appB = { ...me, grant: 'grant_b', client: 'client_b' };
    const t = await call(appA, 'SendMessage', {
      ...message([{ data: { skill: 'list_flows' } }]),
      configuration: {
        taskPushNotificationConfig: {
          url: 'https://hooks.example/a',
          authentication: { scheme: 'Bearer', credentials: 'secret-a' },
        },
      },
    });
    const taskId = (t.result!.task as Json).id as string;
    // The other app can't see the task, its push config, or its credentials.
    expect((await call(appB, 'GetTask', { id: taskId })).error).toBeDefined();
    const theirs = await call(appB, 'ListTaskPushNotificationConfigs', { taskId });
    expect(JSON.stringify(theirs)).not.toContain('secret-a');
    expect((await call(appA, 'GetTask', { id: taskId })).result?.id).toBe(taskId);

    // Disconnecting app A drops its push configs, and only its.
    const { EngineApi } = await import('../src/api');
    const api = new EngineApi({ waitUntil: () => {} } as never, env);
    expect(await api.dropA2aPushes('user', me.id, ['grant_a'])).toEqual({ configs: 1 });
    expect(
      (await call(appA, 'ListTaskPushNotificationConfigs', { taskId })).result?.configs ?? [],
    ).toHaveLength(0);
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

  it('holds a cart submit proposed in chat to the cart it showed', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const op = person('operator', 'cart-chat@example.com');
    const actor = { kind: 'staff' as const, id: op.id, name: op.name, role: op.role };
    const made = await createCart(env, {
      title: 'Chat cart',
      flowId: 'tpl-b2b-order',
      createdBy: op.id,
    });
    if (!made.ok) throw new Error(made.error);
    await changeCart(env, made.id, { op: 'add', sku: 'WID-100', qty: 1 }, actor);

    const proposed = await send(op, [{ text: `submit ${made.id}` }]);
    expect(proposed.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(proposed.artifacts[0].parts[0].data).toMatchObject({ tool: 'submit_cart' });
    expect(proposed.artifacts[0].parts[0].data.preview).not.toHaveProperty('bound');
    // Someone changes the cart before the caller confirms.
    await changeCart(env, made.id, { op: 'add', sku: 'WID-100', qty: 50 }, actor);
    const stale = await send(op, [{ data: { confirm: true } }], {
      taskId: proposed.id,
      contextId: proposed.contextId,
    });
    expect(stale.status.state).toBe('TASK_STATE_REJECTED');
    expect(statusText(stale)).toContain('changed since you confirmed');
    const cart = await env.DB.prepare('SELECT status, order_id FROM carts WHERE id = ?')
      .bind(made.id)
      .first<{ status: string; order_id: string | null }>();
    expect(cart).toEqual({ status: 'open', order_id: null });

    // A typed skill holds the submit to the version its caller read, if it names one.
    const renamed = await changeCart(env, made.id, { op: 'rename', title: 'Chat cart 2' }, actor);
    if (!renamed.ok) throw new Error(renamed.error);
    const version = renamed.cart.version;
    const typedStale = await send(op, [
      { data: { skill: 'submit_cart', input: { cartId: made.id, cartVersion: version - 1 } } },
    ]);
    expect(typedStale.status.state).toBe('TASK_STATE_REJECTED');
    expect(statusText(typedStale)).toContain(`changed since version ${version - 1}`);

    const again = await send(op, [{ text: `submit ${made.id}` }]);
    const done = await send(op, [{ data: { confirm: true } }], {
      taskId: again.id,
      contextId: again.contextId,
    });
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
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

describe('A2A push notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Push = { url: string; headers: Headers; body: Json };
  /** Captures outbound POSTs; `fail` answers 500 for the first N to each URL. */
  function receiver(fail = 0) {
    const received: Push[] = [];
    const tries = new Map<string, number>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const n = (tries.get(u) ?? 0) + 1;
      tries.set(u, n);
      if (n <= fail) return new Response('nope', { status: 500 });
      received.push({
        url: u,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Json,
      });
      return new Response('ok');
    });
    return received;
  }
  const states = (pushes: Push[], taskId: string) =>
    pushes
      .map((p) => p.body.statusUpdate ?? p.body.task)
      .filter((u) => u && (u.taskId ?? u.id) === taskId)
      .map((u) => u.status?.state as string);

  it('pushes a task’s updates, including after the request has ended', async () => {
    const received = receiver();
    await fastWorkflows();
    const op = person('operator', 'push@example.com');
    const placed = (
      await call(op, 'SendMessage', {
        ...message([
          { data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } } },
        ]),
        configuration: {
          taskPushNotificationConfig: { url: 'https://hooks.example/a2a', token: 'tok_1' },
        },
      })
    ).result!.task as Json;
    const orderId = placed.artifacts[0].parts[0].data.orderId as string;
    await until(
      async () => states(received, placed.id).includes('TASK_STATE_INPUT_REQUIRED'),
      'the push for the approval',
    );
    const first = received.find((p) => p.url === 'https://hooks.example/a2a')!;
    expect(first.headers.get('x-a2a-notification-token')).toBe('tok_1');
    expect(first.headers.get('content-type')).toContain('application/a2a+json');

    // The request is over. The approval is decided elsewhere (the order page), and the task's
    // URL still hears about it.
    const before = received.length;
    const wait = (await state(orderId)).waits.find((w) => w.kind === 'approval')!;
    await env.ORDER_AGENT.getByName(orderId).decide(wait.nodeId, 'approved', 'someone@example.com');
    await until(
      async () => received.slice(before).some((p) => p.body.statusUpdate?.taskId === placed.id),
      'a push after the request ended',
    );
    const later = received.slice(before).map((p) => p.body.statusUpdate?.status);
    expect(JSON.stringify(later)).not.toContain('Approve B2B order');
    // Every update is pushed once: no state and line repeats back to back.
    const lines = received
      .map((p) => p.body.statusUpdate ?? p.body.task)
      .filter((u) => u && (u.taskId ?? u.id) === placed.id)
      .map((u) => `${u.status?.state} ${JSON.stringify(u.status?.message?.parts ?? [])}`);
    expect(lines.filter((l, i) => i > 0 && l === lines[i - 1])).toEqual([]);
  });

  it('stops pushing once the caller is disabled', async () => {
    const received = receiver();
    await fastWorkflows();
    const op = person('operator', 'leaver@example.com');
    const placed = (
      await call(op, 'SendMessage', {
        ...message([
          { data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } } },
        ]),
        configuration: { taskPushNotificationConfig: { url: 'https://hooks.example/leaver' } },
      })
    ).result!.task as Json;
    const orderId = placed.artifacts[0].parts[0].data.orderId as string;
    await until(
      async () => states(received, placed.id).includes('TASK_STATE_INPUT_REQUIRED'),
      'the push for the approval',
    );
    await createDb(env.DB).insert(users).values({
      id: op.id,
      email: op.email!,
      name: op.name,
      role: 'operator',
      createdAt: 0,
      disabledAt: Date.now(),
    });

    const before = received.length;
    const wait = (await state(orderId)).waits.find((w) => w.kind === 'approval')!;
    await env.ORDER_AGENT.getByName(orderId).decide(wait.nodeId, 'approved', 'someone@example.com');
    await until(
      async () => !(await state(orderId)).waits.some((w) => w.nodeId === wait.nodeId),
      'the approval to be decided',
    );
    await runDurableObjectAlarm(env.A2A_AGENT.getByName(`user:${op.id}`));
    await new Promise((r) => setTimeout(r, 300));
    expect(received.slice(before)).toEqual([]);
  });

  it('forgets every push config when the caller’s apps are disconnected', async () => {
    receiver(Number.POSITIVE_INFINITY);
    const viewer = person('viewer', 'gone@example.com');
    const t = await call(viewer, 'SendMessage', {
      ...message([{ data: { skill: 'list_flows' } }]),
      configuration: { taskPushNotificationConfig: { url: 'https://hooks.example/gone' } },
    });
    const taskId = (t.result!.task as Json).id as string;
    const { EngineApi } = await import('../src/api');
    const api = new EngineApi({ waitUntil: () => {} } as never, env);
    expect(await api.dropA2aPushes('user', viewer.id)).toEqual({ configs: 1 });
    const listed = await call(viewer, 'ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result?.configs ?? []).toHaveLength(0);
    const queued = await runInDurableObject(
      env.A2A_AGENT.getByName(`user:${viewer.id}`),
      async (_i, state) =>
        state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM push_outbox WHERE status = 'pending'")
          .one().n,
    );
    expect(queued).toBe(0);
  });

  it('manages push configs with the config methods, and refuses unsafe URLs', async () => {
    receiver();
    const viewer = person('viewer', 'cfg@example.com');
    const task = await send(viewer, [{ data: { skill: 'list_flows' } }]);
    const created = await call(viewer, 'CreateTaskPushNotificationConfig', {
      taskId: task.id,
      url: 'https://hooks.example/cfg',
      authentication: { scheme: 'Bearer', credentials: 's3cret' },
    });
    expect(created.result?.id).toBeTruthy();
    const listed = await call(viewer, 'ListTaskPushNotificationConfigs', { taskId: task.id });
    expect(listed.result?.configs).toHaveLength(1);
    expect(listed.result?.configs[0]).toMatchObject({ url: 'https://hooks.example/cfg' });
    // The credentials are stored encrypted, and read back in the clear.
    const raw = await runInDurableObject(
      env.A2A_AGENT.getByName(`user:${viewer.id}`),
      async (_i, state) =>
        state.storage.sql
          .exec<{ auth_credentials: string }>('SELECT auth_credentials FROM push_configs')
          .one().auth_credentials,
    );
    expect(isEncrypted(raw)).toBe(true);
    expect(raw).not.toContain('s3cret');

    const unsafe = await call(viewer, 'CreateTaskPushNotificationConfig', {
      taskId: task.id,
      url: 'http://hooks.example/plain',
    });
    expect(unsafe.error?.message).toContain('https');

    await call(viewer, 'DeleteTaskPushNotificationConfig', {
      taskId: task.id,
      id: created.result!.id,
    });
    const after = await call(viewer, 'ListTaskPushNotificationConfigs', { taskId: task.id });
    expect(after.result?.configs ?? []).toHaveLength(0);
  });

  it('sends the configured authentication, and retries a failing receiver', async () => {
    const received = receiver(1);
    const viewer = person('viewer', 'retry@example.com');
    const t = await call(viewer, 'SendMessage', {
      ...message([{ data: { skill: 'list_flows' } }]),
      configuration: {
        taskPushNotificationConfig: {
          url: 'https://hooks.example/retry',
          authentication: { scheme: 'Bearer', credentials: 'abc' },
        },
      },
    });
    const taskId = (t.result!.task as Json).id as string;
    const stub = env.A2A_AGENT.getByName(`user:${viewer.id}`);
    // The first try failed; make the retry due now and run the alarm.
    await until(
      async () =>
        runInDurableObject(stub, async (_i, state) => {
          const rows = state.storage.sql
            .exec<{ attempts: number }>('SELECT attempts FROM push_outbox WHERE attempts > 0')
            .toArray();
          if (!rows.length) return false;
          state.storage.sql.exec('UPDATE push_outbox SET next_at = 0');
          return true;
        }),
      'a failed first try',
    );
    await runDurableObjectAlarm(stub);
    await until(async () => states(received, taskId).length > 0, 'the retried push');
    expect(received[0]!.headers.get('authorization')).toBe('Bearer abc');
    await until(
      async () =>
        runInDurableObject(
          stub,
          async (_i, state) =>
            state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM push_outbox').one()
              .n === 0,
        ),
      'the outbox to empty',
    );
  });

  it('doesn’t follow a receiver’s redirect, so the credentials stay with its own URL', async () => {
    const seen: { url: string; redirect?: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), redirect: init?.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example/' },
      });
    });
    const viewer = person('viewer', 'redirect@example.com');
    await call(viewer, 'SendMessage', {
      ...message([{ data: { skill: 'list_flows' } }]),
      configuration: {
        taskPushNotificationConfig: {
          url: 'https://hooks.example/moved',
          authentication: { scheme: 'Bearer', credentials: 'abc' },
        },
      },
    });
    const stub = env.A2A_AGENT.getByName(`user:${viewer.id}`);
    await until(
      async () =>
        runInDurableObject(stub, async (_i, state) => {
          const rows = state.storage.sql
            .exec<{ last_error: string | null }>(
              'SELECT last_error FROM push_outbox WHERE attempts > 0',
            )
            .toArray();
          return rows.length > 0 && rows.every((r) => r.last_error?.includes('302'));
        }),
      'a refused redirect',
    );
    expect(
      seen.every((s) => s.url === 'https://hooks.example/moved' && s.redirect === 'manual'),
    ).toBe(true);
  });

  it('drops what is still queued when a config is deleted', async () => {
    const received = receiver(Number.POSITIVE_INFINITY);
    const viewer = person('viewer', 'drop@example.com');
    const t = await call(viewer, 'SendMessage', {
      ...message([{ data: { skill: 'list_flows' } }]),
      configuration: { taskPushNotificationConfig: { url: 'https://hooks.example/drop' } },
    });
    const taskId = (t.result!.task as Json).id as string;
    const stub = env.A2A_AGENT.getByName(`user:${viewer.id}`);
    const queued = () =>
      runInDurableObject(
        stub,
        async (_i, state) =>
          state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM push_outbox WHERE status = 'pending'")
            .one().n,
      );
    await until(async () => (await queued()) === 4, 'every update queued after failing');
    const [config] = (await call(viewer, 'ListTaskPushNotificationConfigs', { taskId })).result!
      .configs as Json[];
    await call(viewer, 'DeleteTaskPushNotificationConfig', { taskId, id: config!.id });
    expect(await queued()).toBe(0);
    vi.restoreAllMocks();
    const after = receiver();
    await runDurableObjectAlarm(stub);
    expect(after).toHaveLength(0);
    expect(received).toHaveLength(0);
  });
});

describe('A2A 0.3 clients', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A 0.3 call: its own method names, no A2A-Version header. */
  async function legacy(p: Principal, method: string, params: Json) {
    const res = await worker.fetch(
      new Request('https://engine/a2a', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signed(p, '/a2a'),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      }),
      env,
    );
    return res;
  }
  const legacyMessage = (parts: Json[], extra: Json = {}) => ({
    message: {
      kind: 'message',
      messageId: `l-${++m}-${Date.now()}`,
      role: 'user',
      parts,
      ...extra,
    },
  });

  it('answers 0.3 method names in 0.3 shapes', async () => {
    const viewer = person('viewer', 'old@example.com');
    const sent = (await (
      await legacy(
        viewer,
        'message/send',
        legacyMessage([{ kind: 'data', data: { skill: 'list_flows' } }]),
      )
    ).json()) as Json;
    expect(sent.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
    expect(sent.result.artifacts[0].parts[0]).toMatchObject({ kind: 'data' });

    const got = (await (await legacy(viewer, 'tasks/get', { id: sent.result.id })).json()) as Json;
    expect(got.result).toMatchObject({ id: sent.result.id, status: { state: 'completed' } });

    // The same task reads in 1.0 shapes over the 1.0 methods.
    const v1 = await call(viewer, 'GetTask', { id: sent.result.id });
    expect(v1.result?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('follows an order and takes a 0.3 reply', async () => {
    await fastWorkflows();
    const op = person('operator', 'old-op@example.com');
    const placed = (
      (await (
        await legacy(
          op,
          'message/send',
          legacyMessage([
            {
              kind: 'data',
              data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } },
            },
          ]),
        )
      ).json()) as Json
    ).result;
    expect(placed.status.state).toBe('input-required');
    const orderId = placed.artifacts[0].parts[0].data.orderId as string;

    const res = await legacy(
      op,
      'message/stream',
      legacyMessage([{ kind: 'data', data: { decision: 'approved' } }], {
        taskId: placed.id,
        contextId: placed.contextId,
      }),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as Json);
    expect(events.every((e) => !e.error)).toBe(true);
    expect(events.map((e) => e.result?.kind)).toContain('status-update');
    await until(async () => {
      const s = await state(orderId);
      return s.waits.some((w) => w.kind === 'approval') ? false : s;
    }, 'the decision');
    expect(JSON.stringify(await state(orderId))).toContain('old-op@example.com via A2A');
  });

  it('pushes 0.3-shaped notifications to a URL registered over 0.3', async () => {
    const received: Json[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      received.push(JSON.parse(String(init?.body)) as Json);
      return new Response('ok');
    });
    await fastWorkflows();
    const op = person('operator', 'old-push@example.com');
    const placed = (
      (await (
        await legacy(
          op,
          'message/send',
          legacyMessage([
            {
              kind: 'data',
              data: { skill: 'place_order', input: { flowId: 'tpl-b2b-order', input: b2b } },
            },
          ]),
        )
      ).json()) as Json
    ).result;
    const orderId = placed.artifacts[0].parts[0].data.orderId as string;
    const set = (await (
      await legacy(op, 'tasks/pushNotificationConfig/set', {
        taskId: placed.id,
        pushNotificationConfig: { url: 'https://hooks.example/old', token: 'old-tok' },
      })
    ).json()) as Json;
    expect(set.error).toBeUndefined();

    // The order moves outside any request; the update goes out in the 0.3 shape, which is the
    // whole task (`kind: "task"`, 0.3 state names), with no StreamResponse wrapper.
    const wait = (await state(orderId)).waits.find((w) => w.kind === 'approval')!;
    await env.ORDER_AGENT.getByName(orderId).decide(wait.nodeId, 'approved', 'someone@example.com');
    await until(async () => received.length > 0, 'the 0.3 push');
    expect(received[0]).toMatchObject({ kind: 'task', id: placed.id });
    expect(received[0]!.status.state).not.toMatch(/^TASK_STATE_/);
    expect(received[0]).not.toHaveProperty('statusUpdate');
  });
  it('adds the wire version to a push table made before 0.3 support', async () => {
    const stub = env.A2A_AGENT.getByName('user:usr_pre03');
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE IF EXISTS push_configs');
      sql.exec(`CREATE TABLE push_configs (
        task_id TEXT NOT NULL, id TEXT NOT NULL, url TEXT NOT NULL, token TEXT NOT NULL DEFAULT '',
        auth_scheme TEXT, auth_credentials TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, id))`);
      sql.exec(
        "INSERT INTO push_configs (task_id, id, url, created_at) VALUES ('t1', 'c1', 'https://x.example', 0)",
      );
      const store = new SqlPushStore(sql, env);
      expect(await store.loadWithMetadata('t1')).toEqual([
        expect.objectContaining({ wireVersion: '1.0' }),
      ]);
    });
  });
});
