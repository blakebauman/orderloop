import { describe, expect, it } from 'vitest';
import {
  atLeast,
  OWN_ORDER_REFUSAL,
  ownOrderRefusal,
  PRINCIPAL_TTL_MS,
  type Principal,
  SSO_LINK_TTL_MS,
  signCartGuest,
  signCartGuestSession,
  signPlatform,
  signPrincipal,
  signRpcActor,
  signSsoFlow,
  signSsoLink,
  verifyCartGuest,
  verifyCartGuestSession,
  verifyPlatform,
  verifyPrincipal,
  verifyRpcActor,
  verifySsoFlow,
  verifySsoLink,
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
    // A connected app's request names its grant and client.
    const app = await signPrincipal(key, { ...p, grant: 'g1', client: 'c1' }, '/a2a', now);
    expect(await verifyPrincipal([key], app, '/a2a', now)).toEqual({
      ...p,
      grant: 'g1',
      client: 'c1',
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

describe('signed platform header', () => {
  const key = 'k1';
  const c = {
    id: 'ucp_1',
    name: 'Shopping agent',
    profileUrl: 'https://agent.example/profile',
    origin: 'https://shop.example',
  };
  const now = 1_700_000_000_000;

  it('round-trips a platform for its path until it expires', async () => {
    const header = await signPlatform(key, c, '/ucp/v1/checkout-sessions', now);
    expect(await verifyPlatform([key], header, '/ucp/v1/checkout-sessions', now)).toEqual(c);
    expect(await verifyPlatform([key], header, '/ucp/v1/orders/x', now)).toBeNull();
    expect(
      await verifyPlatform([key], header, '/ucp/v1/checkout-sessions', now + PRINCIPAL_TTL_MS),
    ).toBeNull();
    expect(await verifyPlatform(['k2'], header, '/ucp/v1/checkout-sessions', now)).toBeNull();
  });

  it('never passes for a principal, nor a principal for a platform', async () => {
    const platform = await signPlatform(key, c, '/mcp', now);
    expect(await verifyPrincipal([key], platform, '/mcp', now)).toBeNull();
    const person = await signPrincipal(
      key,
      { kind: 'user', id: 'usr_1', name: 'Ada', role: 'admin' },
      '/ucp/mcp',
      now,
    );
    expect(await verifyPlatform([key], person, '/ucp/mcp', now)).toBeNull();
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

describe('cart guest envelopes', () => {
  const key = 'k';
  const now = 1_000_000;
  const g = { cartId: 'cart_1', id: 'guest:ann', name: 'Ann' };
  const path = '/agents/cart-agent/cart_1';

  it('admits a guest only on the path it was signed for, and never as anything else', async () => {
    const header = await signCartGuest(key, g, path, now);
    expect(await verifyCartGuest([key], header, path, now)).toEqual(g);
    expect(await verifyCartGuest([key], header, '/agents/cart-agent/cart_2', now)).toBeNull();
    expect(await verifyCartGuest([key], header, path, now + PRINCIPAL_TTL_MS + 1)).toBeNull();
    expect(await verifyCartGuest(['other'], header, path, now)).toBeNull();
    expect(await verifyPrincipal([key], header, path, now)).toBeNull();
    expect(await verifyPlatform([key], header, path, now)).toBeNull();
    const staff = await signPrincipal(
      key,
      { kind: 'user', id: 'usr_1', name: 'A', role: 'admin' },
      path,
      now,
    );
    expect(await verifyCartGuest([key], staff, path, now)).toBeNull();
  });

  it('keeps a guest session cookie to its cart until the cart closes', async () => {
    const cookie = await signCartGuestSession(key, g, now + 60_000);
    expect(await verifyCartGuestSession([key], cookie, 'cart_1', now)).toEqual(g);
    expect(await verifyCartGuestSession([key], cookie, 'cart_2', now)).toBeNull();
    expect(await verifyCartGuestSession([key], cookie, 'cart_1', now + 60_001)).toBeNull();
    // The cookie is never a socket header, and a socket header never a cookie.
    expect(await verifyCartGuest([key], cookie, path, now)).toBeNull();
    const header = await signCartGuest(key, g, path, now);
    expect(await verifyCartGuestSession([key], header, 'cart_1', now)).toBeNull();
  });
});

describe('signed actors on binding calls', () => {
  const key = 'k';
  const now = 1_000_000;
  const ann = { kind: 'staff' as const, id: 'usr_1', name: 'ann@x.com', role: 'approver' as const };

  it('holds an actor to the one call it was signed for, for a minute', async () => {
    const a = await signRpcActor(key, ann, 'decide:ord_1', now);
    expect(await verifyRpcActor([key], a, 'decide:ord_1', now)).toEqual(ann);
    expect(await verifyRpcActor([key], a, 'decide:ord_2', now)).toBeNull();
    expect(await verifyRpcActor([key], a, 'cart:ord_1', now)).toBeNull();
    expect(await verifyRpcActor([key], a, 'decide:ord_1', now + PRINCIPAL_TTL_MS + 1)).toBeNull();
    expect(await verifyRpcActor(['other'], a, 'decide:ord_1', now)).toBeNull();
    // Never a principal header, nor a principal header an actor.
    expect(await verifyPrincipal([key], a, 'decide:ord_1', now)).toBeNull();
    const p = await signPrincipal(key, { ...ann, kind: 'user' }, 'decide:ord_1', now);
    expect(await verifyRpcActor([key], p, 'decide:ord_1', now)).toBeNull();
    const guest = { kind: 'guest' as const, id: 'guest:b', name: 'Bea' };
    expect(
      await verifyRpcActor([key], await signRpcActor(key, guest, 'cart:c', now), 'cart:c', now),
    ).toEqual(guest);
  });
});

describe('pending single sign-on links', () => {
  const key = 'k';
  const now = 1_000_000;
  const link = { userId: 'usr_1', sub: 'idp|ann' };

  it('keeps a link for ten minutes, under its own envelope only', async () => {
    const cookie = await signSsoLink(key, link, now);
    expect(await verifySsoLink([key], cookie, now)).toEqual(link);
    expect(await verifySsoLink(['other', key], cookie, now)).toEqual(link);
    expect(await verifySsoLink([key], cookie, now + SSO_LINK_TTL_MS + 1)).toBeNull();
    expect(await verifySsoLink(['other'], cookie, now)).toBeNull();
    expect(await verifyPrincipal([key], cookie, 'sso-link', now)).toBeNull();
    expect(await verifyCartGuestSession([key], cookie, 'sso-link', now)).toBeNull();
    const staff = await signPrincipal(
      key,
      { kind: 'user', id: 'usr_1', name: 'A', role: 'admin' },
      'sso-link',
      now,
    );
    expect(await verifySsoLink([key], staff, now)).toBeNull();
  });
});

describe('the single sign-on flow cookie', () => {
  const key = 'k'.repeat(32);
  const now = 1_700_000_000_000;
  const flow = { state: 's', nonce: 'n', verifier: 'v', next: '/', reauth: { at: now } };

  it('reads back only what it sealed, with this key, until it expires', async () => {
    const cookie = await signSsoFlow(key, flow, now + 600_000);
    expect(await verifySsoFlow([key], cookie, now)).toEqual(flow);
    expect(await verifySsoFlow(['other'.repeat(8), key], cookie, now)).toEqual(flow);
    expect(await verifySsoFlow(['other'.repeat(8)], cookie, now)).toBeNull();
    expect(await verifySsoFlow([key], cookie, now + 600_001)).toBeNull();
    // An edited payload, and another envelope signed with the same key.
    const [v, , sig] = cookie.split('.');
    const forged = btoa(
      JSON.stringify({ flow: { ...flow, reauth: { at: 0 } }, path: 'sso', exp: now + 600_000 }),
    );
    expect(await verifySsoFlow([key], `${v}.${forged}.${sig}`, now)).toBeNull();
    const staff = await signPrincipal(
      key,
      { kind: 'user', id: 'u', name: 'A', role: 'admin' },
      'sso',
      now,
    );
    expect(await verifySsoFlow([key], staff, now)).toBeNull();
  });
});
