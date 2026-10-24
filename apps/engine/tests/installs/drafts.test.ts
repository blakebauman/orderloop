import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type OrderState, type Principal, validateGraph } from '@orderloop/core';
import { createDb, installedPlugins, publishFlow } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type DraftAnswer,
  draftManifest,
  draftPlugin,
  heuristicDraft,
  hostModule,
} from '../../src/assistant/plugin-draft';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { runCases } from '../../src/plugin-cases';
import { dropInstallsCache } from '../../src/plugin-host';
import * as installs from '../../src/plugin-installs';
import { plugin, pluginStatuses, registry } from '../../src/plugins';
import { edge, node, settled, stampInput } from '../plugin-helpers';

const admin: Principal = { kind: 'user', id: 'usr_admin', name: 'Ann', role: 'admin' };
const db = () => createDb(env.DB);
const via = { via: 'assistant' as const };

/** The env with a model that answers `reply` (as Workers AI would), instead of mock mode. */
const answering = (reply: unknown) =>
  ({
    ...env,
    AI_MODE: 'model',
    AI: { run: async () => ({ response: reply }) },
  }) as unknown as Env;

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'drafted',
    (err: Error) => err.message,
  );

/** A model's draft: one rule, with whatever is overridden. */
const answer = (over: Partial<DraftAnswer> = {}): DraftAnswer => ({
  ...heuristicDraft('hold orders over $100'),
  name: 'Big orders',
  ...over,
});

/** start → reserve → price → rule (`limit`) → held | passed. */
const ruleFlow = (id: string, type: string, limit: number) => ({
  id,
  name: 'Drafted rule',
  description: '',
  model: 'b2b',
  channels: [],
  nodes: [
    node('start', 'trigger.manual'),
    node('reserve', 'commerce.reserve_inventory'),
    node('price', 'commerce.price'),
    node('rule', type, { limit }),
    node('held', 'control.end', { outcome: 'completed', reason: 'held' }),
    node('passed', 'control.end', { outcome: 'completed', reason: 'passed' }),
  ],
  edges: [
    edge('start', 'reserve'),
    edge('reserve', 'price', 'ok'),
    edge('price', 'rule'),
    edge('rule', 'held', 'hold'),
    edge('rule', 'passed', 'ok'),
  ],
});

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
async function run(flowId: string) {
  await introspector?.dispose();
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, { flowId, input: stampInput() });
  return (await settled(orderId, 45_000)) as OrderState;
}

beforeAll(async () => {
  await ensureTemplates(env);
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
  dropInstallsCache();
});

describe('plugins the assistant drafts', () => {
  it('refuses to draft while the deployment doesn’t allow it', async () => {
    const off = { ...env, ASSISTANT_PLUGINS: '' } as Env;
    expect(await refusal(draftPlugin(off, admin, 'hold orders over $5,000', via))).toMatch(
      /doesn’t let the assistant draft plugins/,
    );
  });

  it('builds a manifest that reaches nothing, whatever the model asks for', async () => {
    const greedy = {
      ...answer(),
      egress: ['evil.test'],
      secrets: [{ name: 'KEY' }],
      personalData: 'send',
      nav: [{ label: 'x', path: '/plugins/x/', icon: 'x' }],
    };
    const r = await draftPlugin(answering(greedy), admin, 'hold big orders', via);
    expect(r).toMatchObject({ id: 'ai-big-orders', version: '1', cases: { total: 2, passed: 2 } });
    const [row] = await db()
      .select()
      .from(installedPlugins)
      .where(eq(installedPlugins.id, 'ai-big-orders'));
    const m = JSON.parse(row!.manifest);
    expect(m).toMatchObject({
      egress: [],
      secrets: [],
      personalData: 'redact',
      nav: [],
      publicPaths: [],
      events: [],
      provides: [],
    });
    expect(row).toMatchObject({ publisher: 'assistant', status: 'pending' });
  });

  it('refuses code that reaches for what a rule never needs', async () => {
    const bad = (code: string) =>
      refusal(draftPlugin(answering(answer({ code })), admin, 'big orders', via));
    expect(await bad("const rules = { over_limit: () => fetch('https://evil.test') };")).toMatch(
      /uses “fetch”/,
    );
    expect(await bad("import x from 'y';\nconst rules = {};")).toMatch(/uses “import”/);
    expect(await bad(`const rules = {}; // ${'x'.repeat(17 * 1024)}`)).toMatch(/over 16 KiB/);
    expect(await bad('const handlers = {};')).toMatch(/const rules/);
    expect(await bad('const rules = { over_limit: () => ({}).constructor };')).toMatch(
      /uses “constructor”/,
    );
    expect(await bad('const rules = { over_limit: () => \\u0066etch };')).toMatch(/an escape/);
    // What a summary or a comment says is not code: these draft.
    expect(
      await bad(
        "// export orders shipping abroad\nconst rules = { over_limit: ({ order, config }) => ({ branch: order.total > config.limit ? 'hold' : 'ok', summary: 'import duty: fetch the form' }) };",
      ),
    ).toBe('drafted');
  });

  it('refuses a stock rule when the model fails, and gives a new request its own id', async () => {
    // The model answers something that isn't a draft: no stand-in.
    expect(await refusal(draftPlugin(answering('nonsense'), admin, 'hold big ones', via))).toMatch(
      /model couldn’t draft that/,
    );
    const first = await draftPlugin(answering(answer({ name: 'Same name' })), admin, 'a', via);
    const second = await draftPlugin(answering(answer({ name: 'Same name' })), admin, 'b', via);
    expect([first.id, second.id]).toEqual(['ai-same-name', 'ai-same-name-2']);
    expect(second.version).toBe('1');
  });

  it('runs its cases in the sandbox, and fails a case whose rule throws', async () => {
    const a = answer({
      code: [
        'const rules = {',
        "  over_limit: ({ order, config }) => { if (order.total === 13) throw new Error('unlucky'); if (order.dateCheck && order.createdAt === 0) return { branch: 'ok' }; return { branch: order.total > config.limit ? 'hold' : 'ok' }; },",
        '};',
      ].join('\n'),
    });
    const manifest = draftManifest('ai-cases', '1', a);
    const code = hostModule(manifest, a.code);
    const results = await runCases(env, code, manifest, [
      {
        name: 'big',
        node: 'over_limit',
        order: { total: 500 },
        config: {},
        expect: { branch: 'hold' },
      },
      {
        name: 'wrong',
        node: 'over_limit',
        order: { total: 5 },
        config: {},
        expect: { branch: 'hold' },
      },
      {
        name: 'throws',
        node: 'over_limit',
        order: { total: 13 },
        config: {},
        expect: { branch: 'ok' },
      },
      { name: 'no step', node: 'other', order: {}, config: {}, expect: { branch: 'ok' } },
      // A case can't be told from an order by its date: this rule's "hold" never happens.
      {
        name: 'dated',
        node: 'over_limit',
        order: { total: 500, dateCheck: true },
        config: {},
        expect: { branch: 'hold' },
      },
    ]);
    expect(results.map((r) => [r.name, r.pass, r.got.branch])).toEqual([
      ['big', true, 'hold'],
      ['wrong', false, 'ok'],
      ['throws', false, null],
      ['no step', false, null],
      ['dated', true, 'hold'],
    ]);
    expect(results[2]!.got.error).toMatch(/unlucky/);
    expect(results[3]!.got.error).toMatch(/no step “other”/);
  });

  it('approves only once its cases pass, then runs on orders', async () => {
    // Its second case expects the wrong branch: 1 of 2 passes.
    const wrong = answer({
      name: 'Threshold',
      cases: [
        {
          name: 'big',
          node: 'over_limit',
          order: { total: 500 },
          config: {},
          expect: { branch: 'hold' },
        },
        {
          name: 'small',
          node: 'over_limit',
          order: { total: 5 },
          config: {},
          expect: { branch: 'hold' },
        },
      ],
    });
    const r = await draftPlugin(answering(wrong), admin, 'hold orders over $100', via);
    expect(r).toMatchObject({ id: 'ai-threshold', cases: { total: 2, passed: 1 } });
    const approve = () =>
      installs.approvePlugin(env, r.id, r.sha, { personalData: false }, admin.id);
    await expect(approve()).rejects.toThrow(/1 of 2 cases fail/);
    // Pending: its node isn't installed.
    const issues = validateGraph(ruleFlow('x', 'ai-threshold.over_limit', 0), await registry(env));
    expect(issues.errors.map((e) => e.message).join('\n')).toMatch(
      /Plugin “ai-threshold” is not installed/,
    );

    const fixed = await installs.runPluginCases(env, r.id, r.sha, [
      {
        name: 'big',
        node: 'over_limit',
        order: { total: 500 },
        config: {},
        expect: { branch: 'hold' },
      },
      {
        name: 'small',
        node: 'over_limit',
        order: { total: 5 },
        config: {},
        expect: { branch: 'ok' },
      },
    ]);
    expect(fixed.every((c) => c.pass)).toBe(true);
    const [view] = (await installs.listPluginInstalls(env)).filter((v) => v.id === r.id);
    expect(view).toMatchObject({ request: 'hold orders over $100', publisher: 'assistant' });
    expect(view!.code).toContain('const rules');
    expect(view!.cases?.map((c) => c.pass)).toEqual([true, true]);

    // The deployment stops allowing drafts: nothing drafted starts running.
    const off = { ...env, ASSISTANT_PLUGINS: '' } as Env;
    await expect(
      installs.approvePlugin(off, r.id, r.sha, { personalData: false }, admin.id),
    ).rejects.toThrow(/drafted by the assistant, which this deployment no longer allows/);

    await approve();
    expect((await pluginStatuses(env, true)).find((s) => s.id === r.id)).toMatchObject({
      source: 'installed',
      healthy: true,
    });
    await publishFlow(db(), ruleFlow('test-drafted-hold', 'ai-threshold.over_limit', 0));
    expect((await run('test-drafted-hold')).reason).toBe('held');
    await publishFlow(db(), ruleFlow('test-drafted-pass', 'ai-threshold.over_limit', 1e9));
    expect((await run('test-drafted-pass')).reason).toBe('passed');
  });

  it('needs a case for every step, and serves no pages', async () => {
    const two = answer({
      name: 'Two steps',
      nodes: [
        ...answer().nodes,
        {
          name: 'abroad',
          label: 'Shipping abroad?',
          description: '',
          outputs: ['abroad', 'home'],
          fields: [],
        },
      ],
      code: [
        'const rules = {',
        "  over_limit: ({ order, config }) => ({ branch: order.total > config.limit ? 'hold' : 'ok' }),",
        "  abroad: ({ order }) => ({ branch: order.shipToCountry === 'US' ? 'home' : 'abroad' }),",
        '};',
      ].join('\n'),
    });
    const r = await draftPlugin(answering(two), admin, 'two rules', via);
    await expect(
      installs.approvePlugin(env, r.id, r.sha, { personalData: false }, admin.id),
    ).rejects.toThrow(/Add a test case for Shipping abroad\?/);
    await installs.runPluginCases(env, r.id, r.sha, [
      ...answer().cases,
      {
        name: 'DE',
        node: 'abroad',
        order: { shipToCountry: 'DE' },
        config: {},
        expect: { branch: 'abroad' },
      },
    ]);
    await installs.approvePlugin(env, r.id, r.sha, { personalData: false }, admin.id);
    // Approved, its cases are fixed: a change is a new draft.
    await expect(installs.runPluginCases(env, r.id, r.sha, [])).rejects.toThrow(
      /is active: ask the assistant to revise it/,
    );
    // Whatever its code does, it serves no pages.
    const stub = await plugin(env, r.id, 'serve');
    expect((await stub!.fetch(new Request(`https://x/plugins/${r.id}/`))).status).toBe(404);
  });

  it('revises a drafted plugin as its next version', async () => {
    const r = await draftPlugin(env, admin, 'hold orders over $250', {
      ...via,
      pluginId: 'ai-threshold',
    });
    expect(r).toMatchObject({ id: 'ai-threshold', version: '2', cases: { passed: 2 } });
    await installs.approvePlugin(env, r.id, r.sha, { personalData: false }, admin.id);
    const byVersion = Object.fromEntries(
      (await db().select().from(installedPlugins).where(eq(installedPlugins.id, r.id))).map((x) => [
        x.version,
        x.status,
      ]),
    );
    expect(byVersion).toEqual({ '1': 'superseded', '2': 'active' });
    // It only revises its own: not a plugin installed from a file, nor a made-up id.
    expect(
      await refusal(draftPlugin(env, admin, 'x over 1', { ...via, pluginId: 'acme-carrier' })),
    ).toMatch(/wasn’t drafted by the assistant/);
  });
});
