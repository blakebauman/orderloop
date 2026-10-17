import { describe, expect, it } from 'vitest';
import {
  atLeast,
  OWN_ORDER_REFUSAL,
  ownOrderRefusal,
  PRINCIPAL_TTL_MS,
  type Principal,
  signPrincipal,
  verifyPrincipal,
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
});

describe('signed principal header', () => {
  const key = 'k1';
  const p: Principal = {
    kind: 'user',
    id: 'usr_1',
    name: 'Zoë Ångström',
    email: 'zoe@example.com',
    role: 'approver',
  };
  const now = 1_700_000_000_000;

  it('round-trips a principal for its path, names and session included', async () => {
    expect(
      await verifyPrincipal([key], await signPrincipal(key, p, '/mcp', now), '/mcp', now),
    ).toEqual(p);
    const withSession = await signPrincipal(key, { ...p, session: 'ab12' }, '/a2a', now);
    expect(await verifyPrincipal([key], withSession, '/a2a', now)).toEqual({
      ...p,
      session: 'ab12',
    });
  });

  it('refuses another key, another path, an expired header and a tampered one', async () => {
    const h = await signPrincipal(key, p, '/mcp', now);
    expect(await verifyPrincipal(['other'], h, '/mcp', now)).toBeNull();
    expect(await verifyPrincipal([undefined], h, '/mcp', now)).toBeNull();
    expect(await verifyPrincipal([key], h, '/a2a', now)).toBeNull();
    expect(await verifyPrincipal([key], h, '/mcp', now + PRINCIPAL_TTL_MS)).toBeNull();
    const [v, payload, sig] = h.split('.');
    const admin = btoa(
      JSON.stringify({ p: { ...p, role: 'admin' }, path: '/mcp', exp: now + PRINCIPAL_TTL_MS }),
    ).replace(/=+$/, '');
    expect(await verifyPrincipal([key], `${v}.${admin}.${sig}`, '/mcp', now)).toBeNull();
    expect(await verifyPrincipal([key], `${v}.${payload}.${sig}.x`, '/mcp', now)).toBeNull();
  });

  it('accepts the previous key during a rotation', async () => {
    const old = await signPrincipal('old', p, '/mcp', now);
    expect(await verifyPrincipal(['new', 'old'], old, '/mcp', now)).toEqual(p);
  });

  it('refuses a missing, malformed, unsigned or role-less header', async () => {
    expect(await verifyPrincipal([key], null, '/mcp', now)).toBeNull();
    expect(await verifyPrincipal([key], 'not a header', '/mcp', now)).toBeNull();
    expect(
      await verifyPrincipal(
        [key],
        btoa(JSON.stringify({ id: 'x', name: 'x', role: 'admin' })),
        '/mcp',
        now,
      ),
    ).toBeNull();
    const owner = await signPrincipal(
      key,
      { ...p, role: 'owner' as Principal['role'] },
      '/mcp',
      now,
    );
    expect(await verifyPrincipal([key], owner, '/mcp', now)).toBeNull();
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
