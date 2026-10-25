import { expect, it, describe as suite } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_GROUPS, describe, isAuditGroup } from '../app/lib/audit';

suite('audit vocabulary', () => {
  it('describes events in one line', () => {
    expect(
      describe({
        action: 'team.role_changed',
        actor: 'ops@example.com',
        target: 'ann@example.com',
        detail: { from: 'viewer', to: 'approver' },
      }),
    ).toBe('Changed a role: ann@example.com, Viewer → Approver');
    expect(
      describe({
        action: 'token.created',
        actor: 'ops',
        target: 'ERP sync',
        detail: { role: 'operator' },
      }),
    ).toBe('Created an API token: ERP sync, Operator');
    expect(
      describe({
        action: 'auth.sign_in_failed',
        actor: null,
        target: 'ann@example.com',
        detail: { reason: 'wrong email or password' },
      }),
    ).toBe('Sign-in failed: ann@example.com, wrong email or password');
    expect(
      describe({
        action: 'auth.sign_in',
        actor: 'ann@example.com',
        target: null,
        detail: { twoFactor: 'app' },
      }),
    ).toBe('Signed in: two-factor app');
    expect(
      describe({
        action: 'catalog.products_indexed',
        actor: 'ann@example.com',
        target: null,
        detail: { status: 'done', indexed: 3000, removed: 2, more: true },
      }),
    ).toBe('Updated the product index: 3000 added or renamed, 2 removed, more waiting');
    expect(
      describe({
        action: 'catalog.products_indexed',
        actor: 'ann@example.com',
        target: null,
        detail: { status: 'busy' },
      }),
    ).toBe('Updated the product index: skipped, another run was going');
    expect(
      describe({
        action: 'auth.recovery_code_used',
        actor: 'ann@example.com',
        target: 'ann@example.com',
        detail: { left: 9 },
      }),
    ).toBe('Used a recovery code: ann@example.com, 9 left');
    expect(describe({ action: 'auth.sign_out', actor: 'ann', target: null, detail: null })).toBe(
      'Signed out',
    );
    expect(describe({ action: 'something.new', actor: null, target: null, detail: null })).toBe(
      'something.new',
    );
  });

  it('describes a plugin change by its version, publisher and grant', () => {
    expect(
      describe({
        action: 'plugin.approved',
        actor: 'usr_1',
        target: 'acme-carrier',
        detail: { version: '2', publisher: 'acme', personalData: true },
      }),
    ).toBe('Installed a plugin: acme-carrier, version 2, signed by acme, buyer details granted');
    expect(
      describe({
        action: 'plugin.secret_set',
        actor: 'usr_1',
        target: 'acme-carrier',
        detail: { secret: 'API_KEY' },
      }),
    ).toBe('Set a plugin’s secret: acme-carrier, API_KEY');
    expect(
      describe({
        action: 'plugin.drafted',
        actor: 'usr_1',
        target: 'ai-threshold',
        detail: { version: '2', via: 'assistant', cases: '2/2' },
      }),
    ).toBe(
      'The assistant drafted a plugin: ai-threshold, version 2, 2/2 cases pass, via the assistant',
    );
  });

  it('puts every action in a filter group', () => {
    for (const action of Object.keys(AUDIT_ACTIONS))
      expect(isAuditGroup(action.slice(0, action.indexOf('.')))).toBe(true);
    expect(Object.keys(AUDIT_GROUPS)).toEqual([
      'auth',
      'team',
      'token',
      'scim',
      'api',
      'oauth',
      'integration',
      'ucp',
      'order',
      'approval',
      'cart',
      'flow',
      'webhook',
      'stock',
      'promotion',
      'catalog',
      'plugin',
      'personal_data',
    ]);
    expect(isAuditGroup('orders')).toBe(false);
  });
});
