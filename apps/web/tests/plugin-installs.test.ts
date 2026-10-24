import type { AuditActor, Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = {
  approvePlugin: vi.fn(),
  setPluginSecret: vi.fn(),
  setPluginEnabled: vi.fn(),
  rollbackPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  uploadPlugin: vi.fn(),
  runPluginCases: vi.fn(),
  listPluginInstalls: vi.fn(async () => [] as { id: string; status: string }[]),
};
const audit = vi.fn();
// The step-up passes only for the right password.
const stepUp = vi.fn(async (_r: Request, _by: Principal, given: { password?: string }) =>
  given.password === 'right' ? null : 'Your password is not right.',
);
vi.mock('~/lib/env.server', () => ({ engine: () => engine }));
vi.mock('~/lib/audit.server', () => ({ audit }));
vi.mock('~/lib/auth.server', () => ({ stepUp }));

const { pluginAction } = await import('~/lib/plugin-installs.server');

const admin: Principal & AuditActor = { kind: 'user', id: 'usr_1', name: 'Ann', role: 'admin' };
const request = new Request('https://app.test/plugins', { method: 'POST' });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const sha = 'b'.repeat(64);

beforeEach(() => {
  audit.mockReset();
  stepUp.mockClear();
  for (const fn of Object.values(engine)) fn.mockReset();
  engine.listPluginInstalls.mockResolvedValue([]);
});

describe('the Plugins page’s install actions', () => {
  it.each([
    ['approve', { sha }],
    ['rollback', { sha }],
    ['uninstall', {}],
    ['enable', {}],
  ])('asks for a step-up before it will %s', async (intent, extra) => {
    const r = await pluginAction(
      request,
      admin,
      form({ intent, id: 'acme-carrier', ...extra, password: 'wrong' }),
    );
    expect(r).toEqual({ ok: false, error: 'Your password is not right.' });
    for (const fn of Object.values(engine)) expect(fn).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(request, 'plugin.refused', {
      actor: admin,
      target: 'acme-carrier',
      detail: { intent, error: 'Your password is not right.' },
    });
  });

  it('approves after a step-up, with the grant the admin ticked', async () => {
    engine.approvePlugin.mockResolvedValueOnce({
      ok: true,
      value: { id: 'acme-carrier', version: '2', sha, personalData: true },
    });
    const r = await pluginAction(
      request,
      admin,
      form({ intent: 'approve', id: 'acme-carrier', sha, personalData: 'on', password: 'right' }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(engine.approvePlugin).toHaveBeenCalledWith(
      'acme-carrier',
      sha,
      { personalData: true },
      'usr_1',
    );
    expect(audit).toHaveBeenCalledWith(request, 'plugin.approved', {
      actor: admin,
      target: 'acme-carrier',
      detail: { version: '2', sha: sha.slice(0, 12), personalData: true },
    });
  });

  it('shows the engine’s refusal as it is', async () => {
    engine.uninstallPlugin.mockResolvedValueOnce({
      ok: false,
      error:
        'acme-carrier is still in use: 1 published flows, 0 running orders, 0 labels not voided',
    });
    const r = await pluginAction(
      request,
      admin,
      form({ intent: 'uninstall', id: 'acme-carrier', password: 'right' }),
    );
    expect(r).toEqual({
      ok: false,
      error:
        'acme-carrier is still in use: 1 published flows, 0 running orders, 0 labels not voided',
    });
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.refused');
  });

  it('asks for a step-up to change a running plugin’s secret', async () => {
    engine.listPluginInstalls.mockResolvedValueOnce([{ id: 'acme-carrier', status: 'active' }]);
    const r = await pluginAction(
      request,
      admin,
      form({
        intent: 'secret',
        id: 'acme-carrier',
        name: 'API_KEY',
        value: 'sk-x',
        password: 'no',
      }),
    );
    expect(r).toEqual({ ok: false, error: 'Your password is not right.' });
    expect(engine.setPluginSecret).not.toHaveBeenCalled();
  });

  it('sets a pending plugin’s secret without a step-up, and never audits its value', async () => {
    engine.setPluginSecret.mockResolvedValueOnce({
      ok: true,
      value: { id: 'acme-carrier', name: 'API_KEY' },
    });
    const r = await pluginAction(
      request,
      admin,
      form({ intent: 'secret', id: 'acme-carrier', name: 'API_KEY', value: 'sk-live-9999' }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(stepUp).not.toHaveBeenCalled();
    expect(engine.setPluginSecret).toHaveBeenCalledWith(
      'acme-carrier',
      'API_KEY',
      'sk-live-9999',
      'usr_1',
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('sk-live');
  });

  it('runs a draft’s edited cases without a step-up, and audits how many pass', async () => {
    const cases = [
      { name: 'big', node: 'over_limit', order: { total: 500 }, expect: { branch: 'hold' } },
      { name: 'small', node: 'over_limit', order: { total: 5 }, expect: { branch: 'ok' } },
    ];
    engine.runPluginCases.mockResolvedValueOnce({
      ok: true,
      value: [
        { ...cases[0], pass: true, got: { branch: 'hold' } },
        { ...cases[1], pass: false, got: { branch: 'hold' } },
      ],
    });
    const r = await pluginAction(
      request,
      admin,
      form({ intent: 'cases', id: 'ai-threshold', sha, cases: JSON.stringify(cases) }),
    );
    expect(r).toEqual({ ok: true, done: '1 of 2 cases pass.' });
    expect(stepUp).not.toHaveBeenCalled();
    expect(engine.runPluginCases).toHaveBeenCalledWith('ai-threshold', sha, cases, 'usr_1');
    expect(audit).toHaveBeenCalledWith(request, 'plugin.cases_run', {
      actor: admin,
      target: 'ai-threshold',
      detail: { cases: '1/2' },
    });
    expect(
      await pluginAction(
        request,
        admin,
        form({ intent: 'cases', id: 'ai-threshold', sha, cases: '{not json' }),
      ),
    ).toEqual({ ok: false, error: 'The cases aren’t JSON.' });
  });

  it('refuses an unknown action or plugin id', async () => {
    expect(await pluginAction(request, admin, form({ intent: 'publish' }))).toMatchObject({
      ok: false,
    });
    expect(
      await pluginAction(request, admin, form({ intent: 'disable', id: '../etc' })),
    ).toMatchObject({ ok: false, error: 'Unknown plugin.' });
    for (const fn of Object.values(engine)) expect(fn).not.toHaveBeenCalled();
  });
});
