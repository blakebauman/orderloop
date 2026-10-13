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
    expect(describe({ action: 'auth.sign_out', actor: 'ann', target: null, detail: null })).toBe(
      'Signed out',
    );
    expect(describe({ action: 'something.new', actor: null, target: null, detail: null })).toBe(
      'something.new',
    );
  });

  it('puts every action in a filter group', () => {
    for (const action of Object.keys(AUDIT_ACTIONS))
      expect(isAuditGroup(action.slice(0, action.indexOf('.')))).toBe(true);
    expect(Object.keys(AUDIT_GROUPS)).toEqual(['auth', 'team', 'token', 'api']);
    expect(isAuditGroup('orders')).toBe(false);
  });
});
