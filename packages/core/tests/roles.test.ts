import { describe, expect, it } from 'vitest';
import { atLeast, decodePrincipal, encodePrincipal, type Principal } from '../src/roles';

describe('roles', () => {
  it('orders viewer < approver < operator', () => {
    expect(atLeast('operator', 'approver')).toBe(true);
    expect(atLeast('approver', 'approver')).toBe(true);
    expect(atLeast('viewer', 'approver')).toBe(false);
    expect(atLeast('approver', 'operator')).toBe(false);
    expect(atLeast(null, 'viewer')).toBe(false);
  });

  it('round-trips a principal through the proxy header, names included', () => {
    const p: Principal = {
      kind: 'user',
      id: 'usr_1',
      name: 'Zoë Ångström',
      email: 'zoe@example.com',
      role: 'approver',
    };
    expect(decodePrincipal(encodePrincipal(p))).toEqual(p);
  });

  it('rejects a missing, malformed or role-less header', () => {
    expect(decodePrincipal(null)).toBeNull();
    expect(decodePrincipal('not base64 json')).toBeNull();
    expect(decodePrincipal(btoa(JSON.stringify({ id: 'x', name: 'x', role: 'admin' })))).toBeNull();
  });
});
