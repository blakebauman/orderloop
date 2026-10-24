import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type Attention,
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
} from '@orderloop/core';
import { approvals, auditEvents, createDb, sessions, users } from '@orderloop/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readContext } from '../src/assistant/agent';
import { previewAction, Refused, runAction } from '../src/assistant/data';
import { describeResult, heuristicStep } from '../src/assistant/model';
import { runTool } from '../src/assistant/tools';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { startOrder } from '../src/orders';
import { signed } from './principal';

const db = () => createDb(env.DB);
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

/** A person with a live session, as the web proxy describes them. */
async function who(role: Principal['role'], email: string): Promise<ProxiedPrincipal> {
  const id = `usr_${email.split('@')[0]}`;
  const session = `sess_${id}`;
  await db()
    .insert(users)
    .values({ id, email, name: email.split('@')[0]!, role, createdAt: Date.now() })
    .onConflictDoUpdate({ target: users.id, set: { role, disabledAt: null } });
  await db()
    .insert(sessions)
    .values({
      tokenHash: session,
      userId: id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })
    .onConflictDoNothing();
  return { kind: 'user', id, name: email.split('@')[0]!, email, role, session };
}

const strip = ({ session: _s, ...p }: ProxiedPrincipal): Principal => p;

describe('assistant heuristics (no model)', () => {
  const all = new Set([
    'needs_attention',
    'find_orders',
    'get_order',
    'find_products',
    'list_flows',
    'get_flow',
    'propose_flow_change',
    'decide_approval',
    'deliver_event',
    'cancel_order',
    'publish_flow',
    'run_stock_review',
  ]);
  const ws = { kind: 'workspace' } as const;

  it('reads plain requests into one tool call', () => {
    expect(heuristicStep('What needs me?', ws, all)).toEqual({
      tool: 'needs_attention',
      input: {},
    });
    expect(heuristicStep('Waiting orders over $10k this week', ws, all)).toEqual({
      tool: 'find_orders',
      input: { status: 'waiting', minTotal: 10_000, sinceDays: 7 },
    });
    expect(heuristicStep('approve #k3x9q2', ws, all)).toEqual({
      tool: 'decide_approval',
      input: { orderId: 'k3x9q2', decision: 'approved' },
    });
    // "This order" is the one on screen.
    const order = { kind: 'order', id: 'ord_abc123', label: 'Monitors' } as const;
    expect(heuristicStep('mark payment.received', order, all)).toEqual({
      tool: 'deliver_event',
      input: { orderId: 'ord_abc123', event: 'payment.received' },
    });
    const flow = { kind: 'flow', id: 'tpl-b2b-order', label: 'B2B order' } as const;
    expect(heuristicStep('Add a risk score after credit check', flow, all)).toMatchObject({
      tool: 'propose_flow_change',
      input: { flowId: 'tpl-b2b-order' },
    });
  });

  it('never offers a tool the role lacks, and says so instead', () => {
    const viewer = new Set(['needs_attention', 'find_orders', 'get_order']);
    const step = heuristicStep('cancel #k3x9q2', ws, viewer);
    expect(step).toHaveProperty('text');
    expect('tool' in step).toBe(false);
  });

  it('describes results with links to what it found', () => {
    const empty: Attention = {
      approvals: [],
      failed: [],
      stalled: [],
      counts: { approvals: 0, failed: 0, stalled: 0 },
    };
    expect(describeResult('needs_attention', empty)).toMatch(/^Nothing is waiting/);
    expect(
      describeResult('needs_attention', {
        ...empty,
        approvals: [
          {
            id: 'apr_1',
            orderId: 'ord_xyz987654',
            nodeId: 'approval',
            title: 'Sales approval',
            amount: 1,
            requestedAt: 0,
          },
        ],
        counts: { approvals: 1, failed: 0, stalled: 0 },
      }),
    ).toContain('[#987654](/orders/ord_xyz987654)');
    expect(
      describeResult('assess_order', {
        id: 'ord_xyz987654',
        ref: '#987654',
        answers: {
          urgent: { type: 'noul', noul: 0.91 },
          route: {
            type: 'choice',
            choice: 'review',
            probabilities: { review: 0.82, approve: 0.18 },
            confidence: 0.6,
          },
        },
        notes: ['http://x/y.png: only https, data URLs or R2 keys'],
        source: 'model',
      }),
    ).toBe(
      '[#987654](/orders/ord_xyz987654): urgent 0.91 · route → review (82%).\n- Skipped http://x/y.png: only https, data URLs or R2 keys',
    );
  });

  it('reads carts, and keeps a cart’s own words out of links', () => {
    const carts = new Set([...all, 'list_carts', 'get_cart', 'submit_cart']);
    expect(heuristicStep('Which carts are open?', ws, carts)).toEqual({
      tool: 'list_carts',
      input: { status: 'open' },
    });
    expect(heuristicStep('Submit cart_k3x9q2', ws, carts)).toEqual({
      tool: 'submit_cart',
      input: { cartId: 'cart_k3x9q2' },
    });
    expect(heuristicStep('What is in cart_k3x9q2?', ws, carts)).toEqual({
      tool: 'get_cart',
      input: { cartId: 'cart_k3x9q2' },
    });
    const line = describeResult('get_cart', {
      id: 'cart_k3x9q2',
      href: '/carts/cart_k3x9q2',
      title: 'Q4 [click](https://evil.example)',
      status: 'open',
      lines: [{ lineId: 'l1', sku: 'WID-100', qty: 2 }],
      priced: true,
      total: '$43.00',
      notReady: null,
    });
    expect(line).toBe(
      '[cart_k3x9q2](/carts/cart_k3x9q2) Q4 clickhttps://evil.example is **open**: 1 line, $43.00.',
    );
  });

  it('treats a malformed page context as the workspace', () => {
    expect(readContext({ kind: 'order' })).toEqual({ kind: 'workspace' });
    expect(readContext({ kind: 'flow', id: 'f1', label: 'F', graph: { nodes: 'x' } })).toEqual({
      kind: 'flow',
      id: 'f1',
      label: 'F',
    });
  });
});

describe('assistant actions', () => {
  it('submits a cart only once it is ready, as the person, through the assistant', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const op = strip(await who('operator', 'ops@example.com'));
    const viewer = strip(await who('viewer', 'vic@example.com'));
    const cart = (await runTool(
      env,
      op,
      'create_cart',
      { title: 'Q4', flowId: 'tpl-b2b-order' },
      {
        via: 'assistant',
      },
    )) as { id: string };
    expect((await previewAction(env, op, 'submit_cart', { cartId: cart.id })).blocked).toBe(
      'Add at least one line.',
    );
    await runTool(
      env,
      op,
      'change_cart',
      { cartId: cart.id, ops: [{ op: 'add', sku: 'WID-100', qty: 1 }] },
      {
        via: 'assistant',
      },
    );
    expect((await previewAction(env, viewer, 'submit_cart', { cartId: cart.id })).blocked).toBe(
      'This needs the Operator role.',
    );
    await expect(
      runTool(
        env,
        viewer,
        'change_cart',
        { cartId: cart.id, ops: [{ op: 'clear' }] },
        {
          via: 'assistant',
        },
      ),
    ).rejects.toBeInstanceOf(Refused);
    const preview = await previewAction(env, op, 'submit_cart', { cartId: cart.id });
    expect(preview.blocked).toBeUndefined();
    expect(preview.consequences[0]).toMatch(/^1 line · \$/);
    expect(preview.bound).toEqual({ cartVersion: expect.any(Number) });

    // Changed after the person saw it: their confirm doesn't submit what they never saw.
    await runTool(
      env,
      op,
      'change_cart',
      { cartId: cart.id, ops: [{ op: 'add', sku: 'WID-100', qty: 40 }] },
      { via: 'MCP' },
    );
    await expect(
      runAction(env, op, 'submit_cart', { cartId: cart.id }, 'assistant', {
        bound: preview.bound!,
      }),
    ).rejects.toThrow('The cart changed since you confirmed; preview it again.');
    // Nor does a confirm held to nothing.
    await expect(
      runAction(env, op, 'submit_cart', { cartId: cart.id }, 'assistant', { bound: null }),
    ).rejects.toBeInstanceOf(Refused);
    const still = (await runTool(
      env,
      op,
      'get_cart',
      { cartId: cart.id },
      { via: 'assistant' },
    )) as { status: string; orderId: string | null };
    expect(still).toMatchObject({ status: 'open', orderId: null });
    const changes = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'cart.changed'), eq(auditEvents.target, cart.id)));
    expect(changes.map((e) => JSON.parse(e.detail!))).toEqual([
      { op: 'add', via: 'assistant', tool: 'change_cart' },
      { op: 'add', via: 'mcp', tool: 'change_cart' },
    ]);

    const seen = await previewAction(env, op, 'submit_cart', { cartId: cart.id });
    const done = (await runAction(env, op, 'submit_cart', { cartId: cart.id }, 'assistant', {
      bound: seen.bound!,
    })) as { orderId: string };
    const logged = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'order.started'), eq(auditEvents.target, done.orderId)))
      .get();
    expect(JSON.parse(logged!.detail!)).toMatchObject({ cartId: cart.id, via: 'assistant' });
    const created = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'cart.created'), eq(auditEvents.target, cart.id)))
      .get();
    expect(created).toMatchObject({ actor: 'ops@example.com' });
  });

  it('previews a decision against live data and refuses roles that cannot make it', async () => {
    const orderId = await waitingOrder();
    const viewer = strip(await who('viewer', 'vic@example.com'));
    const approver = strip(await who('approver', 'ann@example.com'));

    const blocked = await previewAction(env, viewer, 'decide_approval', {
      orderId,
      decision: 'approved',
    });
    expect(blocked.blocked).toBe('This needs the Approver role.');
    await expect(
      runAction(env, viewer, 'decide_approval', { orderId, decision: 'approved' }),
    ).rejects.toBeInstanceOf(Refused);

    // A #reference resolves, and the card says where the decision leads.
    const ref = `#${orderId.slice(-6)}`;
    const preview = await previewAction(env, approver, 'decide_approval', {
      orderId: ref,
      decision: 'rejected',
      note: 'Over limit',
    });
    expect(preview.blocked).toBeUndefined();
    expect(preview.title).toMatch(/^Reject /);
    expect(preview.consequences).toContain('Note: “Over limit”');

    // Nothing has happened yet: previews are read-only.
    expect((await state(orderId)).waits.some((w) => w.kind === 'approval')).toBe(true);

    await runAction(env, approver, 'decide_approval', {
      orderId: ref,
      decision: 'rejected',
      note: 'Over limit',
    });
    const row = await until(async () => {
      const a = await db().select().from(approvals).where(eq(approvals.orderId, orderId)).get();
      return a?.status === 'rejected' ? a : false;
    }, 'the decision');
    // The audit trail names the person and how they acted.
    expect(row).toMatchObject({ decidedBy: 'ann@example.com via assistant', note: 'Over limit' });
    // And the audit log records it once, as the person, through the assistant.
    const logged = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'approval.decided'), eq(auditEvents.target, orderId)));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor: 'ann@example.com', actorKind: 'user' });
    expect(JSON.parse(logged[0]!.detail!)).toMatchObject({
      decision: 'rejected',
      note: 'Over limit',
      via: 'assistant',
      tool: 'decide_approval',
    });

    // Decided now, so a second try is blocked rather than sent.
    const again = await previewAction(env, approver, 'decide_approval', {
      orderId,
      decision: 'approved',
    });
    expect(again.blocked).toMatch(/Nothing on this order is waiting/);
  });

  it('lists what a cancel will undo, and blocks events nothing waits for', async () => {
    const orderId = await waitingOrder();
    const op = strip(await who('operator', 'ops@example.com'));
    const cancel = await previewAction(env, op, 'cancel_order', {
      orderId,
      reason: 'Duplicate PO',
    });
    expect(cancel.blocked).toBeUndefined();
    expect(cancel.consequences).toEqual(
      expect.arrayContaining(['Closes its open approvals', 'Reason: “Duplicate PO”']),
    );
    const event = await previewAction(env, op, 'deliver_event', {
      orderId,
      event: 'payment.received',
    });
    expect(event.blocked).toMatch(/Nothing on this order is waiting for payment.received/);
    await runAction(env, op, 'cancel_order', { orderId, reason: 'Duplicate PO' }, 'MCP');
    expect((await state(orderId)).reason).toBe('Duplicate PO (ops@example.com via MCP)');
    const logged = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'order.cancelled'), eq(auditEvents.target, orderId)))
      .get();
    expect(JSON.parse(logged!.detail!)).toMatchObject({ reason: 'Duplicate PO', via: 'mcp' });
  });
});

describe('assistant socket', () => {
  const socket = async (name: string, principal: ProxiedPrincipal | null) => {
    const headers = new Headers({ Upgrade: 'websocket' });
    if (principal)
      headers.set(PRINCIPAL_HEADER, await signed(principal, `/agents/assistant-agent/${name}`));
    const res = await worker.fetch(
      new Request(`http://engine/agents/assistant-agent/${name}`, { headers }),
      env,
    );
    const ws = res.webSocket!;
    ws.accept();
    const pending = new Map<
      string,
      (m: { success: boolean; error?: string; result?: unknown }) => void
    >();
    let closed: number | null = null;
    ws.addEventListener('close', (e) => {
      closed = e.code;
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
    });
    let n = 0;
    return {
      call: (method: string, args: unknown[]) =>
        new Promise<{ success: boolean; error?: string; result?: unknown }>((resolve) => {
          const id = `c${++n}`;
          pending.set(id, resolve);
          ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
        }),
      closed: () => closed,
      close: () => ws.close(),
    };
  };

  it('opens only for its own person, and stops when their sign-in ends', async () => {
    const orderId = await waitingOrder();
    const kim = await who('viewer', 'kim@example.com');

    // Someone else's assistant refuses the connection.
    const wrong = await socket('usr_someone_else', kim);
    await until(async () => wrong.closed() === 4403, 'the refusal');

    const mine = await socket(kim.id, kim);
    const res = await mine.call('attention', []);
    expect(res.success).toBe(true);
    const a = res.result as Attention;
    expect(a.approvals.some((x) => x.orderId === orderId)).toBe(true);

    // A viewer can preview, and the preview says they can't act.
    const preview = await mine.call('preview', ['cancel_order', { orderId, reason: 'x' }]);
    expect(preview.result).toMatchObject({ blocked: 'This needs the Operator role.' });

    await db().update(users).set({ disabledAt: Date.now() }).where(eq(users.id, kim.id));
    expect(await mine.call('attention', [])).toMatchObject({
      success: false,
      error: 'Your sign-in has ended. Reload the page to sign in again.',
    });
    mine.close();
  });
});
