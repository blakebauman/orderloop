import { env } from 'cloudflare:workers';
import { ASSISTANT_ROUTING_KEY, type Principal } from '@orderloop/core';
import { auditEvents, createDb, workspaceSettings } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { previewAction, runAction } from '../src/assistant/data';
import { routeQuestion, routingOn } from '../src/assistant/routing';

const db = () => createDb(env.DB);

const ann: Principal = {
  kind: 'user',
  id: 'usr_route_ann',
  name: 'Ann',
  email: 'route-ann@example.com',
  role: 'admin',
};

const ALL = new Set(['cancel_order', 'list_carts', 'get_order', 'find_orders', 'needs_attention']);
const onOrder = { kind: 'order' as const, id: 'ord_routed1', label: 'Order' };

/** The env with Clef answering `yes` for the exact-request question, and counting its calls. */
function withClef(yes: number | Error) {
  const calls: unknown[] = [];
  const e = {
    ...env,
    AI_MODE: 'model',
    AI: {
      run: async (_m: string, input: { model?: string }) => {
        calls.push(input);
        if (yes instanceof Error) throw yes;
        return {
          answers: { exact: { noul: yes } },
          usage: { input_tokens: 40, output_tokens: 2 },
        };
      },
    },
  } as unknown as Env;
  return { e, calls };
}

const turnOn = () =>
  db()
    .insert(workspaceSettings)
    .values({ key: ASSISTANT_ROUTING_KEY, value: 'on', updatedAt: Date.now(), updatedBy: 'test' })
    .onConflictDoUpdate({ target: workspaceSettings.key, set: { value: 'on' } });

afterEach(async () => {
  await db().delete(workspaceSettings).where(eq(workspaceSettings.key, ASSISTANT_ROUTING_KEY));
});

describe('routing typed requests by the decision model', () => {
  it('is off until an admin turns it on, and then asks Clef nothing for what it can’t build', async () => {
    const { e, calls } = withClef(0.99);
    expect(await routingOn(e)).toBe(false);
    expect(await routeQuestion(e, ann, 'cancel this order', onOrder, ALL)).toEqual({
      route: 'model',
      reason: 'off',
    });
    await turnOn();
    // The fixed rules read no single call here: Clef isn't asked.
    expect(
      await routeQuestion(
        e,
        ann,
        'write a short thank-you note to the warehouse',
        { kind: 'workspace' },
        ALL,
      ),
    ).toEqual({ route: 'model', reason: 'no call' });
    expect(calls).toHaveLength(0);
  });

  it('runs an exact request on the rules only when Clef is sure', async () => {
    await turnOn();
    const sure = withClef(0.97);
    expect(await routeQuestion(sure.e, ann, 'cancel this order', onOrder, ALL)).toMatchObject({
      route: 'rules',
      tool: 'cancel_order',
    });
    // Clef read the person's words, the page and the proposed call: nothing else.
    expect(JSON.stringify(sure.calls[0])).toContain('cancel this order');
    expect(JSON.stringify(sure.calls[0])).toContain('ord_routed1');

    const unsure = withClef(0.6);
    expect(
      await routeQuestion(
        unsure.e,
        ann,
        'cancel this order and tell me why it failed',
        onOrder,
        ALL,
      ),
    ).toEqual({ route: 'model', reason: 'unsure' });

    // A question the rules would read as a search ("failing" orders) is the chat model's when
    // Clef says it asks for more than that.
    const why = withClef(0.1);
    expect(
      await routeQuestion(
        why.e,
        ann,
        'why do our B2B orders keep failing?',
        { kind: 'workspace' },
        ALL,
      ),
    ).toEqual({ route: 'model', reason: 'unsure' });

    const down = withClef(new Error('capacity'));
    expect(await routeQuestion(down.e, ann, 'cancel this order', onOrder, ALL)).toEqual({
      route: 'model',
      reason: 'unavailable',
    });
  });

  it('never routes to a tool the role can’t use', async () => {
    await turnOn();
    const { e } = withClef(0.99);
    // Without cancel_order the rules say so in words: that is the chat model's to answer.
    expect(
      await routeQuestion(e, ann, 'cancel this order', onOrder, new Set(['get_order'])),
    ).toEqual({ route: 'model', reason: 'no call' });
  });

  it('never routes to a write that runs without a card', async () => {
    await turnOn();
    const { e, calls } = withClef(0.99);
    expect(
      await routeQuestion(
        e,
        ann,
        'draft a plugin that holds orders over $5000',
        { kind: 'workspace' },
        new Set(['draft_plugin']),
      ),
    ).toEqual({ route: 'model', reason: 'no call' });
    expect(calls).toHaveLength(0);
  });

  it('answers from the rules with an order’s own words as plain text, never as links', async () => {
    const { describeResult } = await import('../src/assistant/model');
    const text = describeResult('get_order', {
      ref: '#abc123',
      href: '/orders/ord_abc123',
      title: '[Pay here](https://evil.example) ![](https://evil.example/p.png)',
      status: 'waiting',
      total: '$10.00',
      customer: '[Acme](https://evil.example)',
      reason: '<img src=x>',
      waits: [{ title: '[w](https://evil.example)', kind: 'approval' }],
      steps: [],
    });
    expect(text).not.toContain('](https://evil');
    expect(text).not.toContain('<img');
    expect(text).toContain('[#abc123](/orders/ord_abc123)');
  });

  it('is set only by an admin, a person, in the app', async () => {
    const operator = { ...ann, id: 'usr_route_op', role: 'operator' as const };
    expect(
      (await previewAction(env, operator, 'set_assistant_routing', { on: true })).blocked,
    ).toBe('This needs the Admin role.');
    const app = { ...ann, grant: 'g1', client: 'c1' };
    expect((await previewAction(env, app, 'set_assistant_routing', { on: true })).blocked).toBe(
      'A person changes the team, signed in as themselves.',
    );
    await expect(runAction(env, ann, 'set_assistant_routing', { on: true }, 'A2A')).rejects.toThrow(
      'This is changed only in the app, by a person signed in.',
    );
  });

  it('is set by an admin on a card in the app, and audited', async () => {
    const card = await previewAction(env, ann, 'set_assistant_routing', { on: true });
    expect(card.consequences[2]).toBe('Actions still stop at their confirm card');
    await runAction(env, ann, 'set_assistant_routing', { on: true }, 'assistant');
    expect(await routingOn(env)).toBe(true);
    const logged = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'team.assistant_routing'))
      .get();
    expect(JSON.parse(logged!.detail!)).toMatchObject({ from: 'off', to: 'on' });
    await expect(
      runAction(env, ann, 'set_assistant_routing', { on: false }, 'MCP'),
    ).rejects.toThrow('This is changed only in the app, by a person signed in.');
  });
});
