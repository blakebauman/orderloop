import { describe, expect, it } from 'vitest';
import {
  atLeast,
  decodePrincipal,
  encodePrincipal,
  OWN_ORDER_REFUSAL,
  ownOrderRefusal,
  type Principal,
} from '../src/roles';

describe('roles', () => {
  it('orders viewer < approver < operator < admin', () => {
    expect(atLeast('admin', 'operator')).toBe(true);
    expect(atLeast('operator', 'admin')).toBe(false);
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
    expect(decodePrincipal(encodePrincipal({ ...p, session: 'ab12' }))).toEqual({
      ...p,
      session: 'ab12',
    });
  });

  it('rejects a missing, malformed or role-less header', () => {
    expect(decodePrincipal(null)).toBeNull();
    expect(decodePrincipal('not base64 json')).toBeNull();
    expect(decodePrincipal(btoa(JSON.stringify({ id: 'x', name: 'x', role: 'owner' })))).toBeNull();
  });
});

describe('separation of duties', () => {
  it('refuses only the starter, and only when the workspace separates duties', () => {
    expect(ownOrderRefusal(true, 'usr_a', 'usr_a')).toBe(OWN_ORDER_REFUSAL);
    expect(ownOrderRefusal(true, 'usr_a', 'usr_b')).toBeNull();
    expect(ownOrderRefusal(false, 'usr_a', 'usr_a')).toBeNull();
    // An order with no starter (a channel, an email, the stock review) is anyone's to decide.
    expect(ownOrderRefusal(true, null, 'usr_a')).toBeNull();
    expect(ownOrderRefusal(true, 'usr_a', undefined)).toBeNull();
  });
});
