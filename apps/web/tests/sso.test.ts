import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SSO,
  decideSso,
  describeSso,
  parseDomains,
  readSsoSettings,
  type SsoSettings,
} from '~/lib/sso';

const env: Record<string, string> = {
  OIDC_ISSUER: 'https://idp.test',
  OIDC_CLIENT_ID: 'client-1',
  OIDC_CLIENT_SECRET: 's3cret',
  PRINCIPAL_KEY: 'test-principal-key-0123456789abcdef',
};

/** What the next `select … get()` reads, in order, and what `update` wrote. */
const rows: unknown[] = [];
const writes: Record<string, unknown>[] = [];
let failNextWrite = false;
const fakeDb = {
  select: () => {
    const q = { from: () => q, where: () => q, get: async () => rows.shift() };
    return q;
  },
  update: () => ({
    set: (v: Record<string, unknown>) => ({
      where: () => {
        writes.push(v);
        const fail = failNextWrite;
        failNextWrite = false;
        return Object.assign(Promise.resolve(), {
          returning: async () => {
            if (fail) throw new Error('UNIQUE constraint failed: users.external_sub');
            return [{ id: 'usr_1' }];
          },
        });
      },
    }),
  }),
};

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ db: () => fakeDb }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn() }));
vi.mock('~/lib/settings.server', () => ({ ssoSettings: async () => DEFAULT_SSO }));
vi.mock('~/lib/auth.server', () => ({
  cookie: (request: Request, name: string) =>
    request.headers
      .get('cookie')
      ?.split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1),
  forgetUserCount: vi.fn(),
  startSession: vi.fn(async () => '__Host-ol_session=new'),
}));

const {
  finishSsoLink,
  pendingSsoLink,
  SsoError,
  signInWithSso,
  ssoConfig,
  startSso,
  verifyCallback,
} = await import('~/lib/sso.server');

describe('SSO settings', () => {
  it('reads domains from an admin’s text, dropping junk and repeats', () => {
    expect(parseDomains('Example.com, @acme.co.uk\nexample.com  not a domain, a@b')).toEqual([
      'example.com',
      'acme.co.uk',
    ]);
  });

  it('never lets someone new join as an admin', () => {
    expect(
      readSsoSettings(JSON.stringify({ jitRole: 'admin', domains: ['x.com'] })).jitRole,
    ).toBeNull();
    expect(
      readSsoSettings(JSON.stringify({ jitRole: 'operator', domains: ['x.com'] })).jitRole,
    ).toBe('operator');
  });

  it('reads stored settings, with anything unreadable at its default', () => {
    expect(readSsoSettings(null)).toEqual(DEFAULT_SSO);
    expect(readSsoSettings('{oops')).toEqual(DEFAULT_SSO);
    expect(
      readSsoSettings(JSON.stringify({ jitRole: 'owner', domains: ['x.com', 'bad'], ssoOnly: 1 })),
    ).toEqual({ jitRole: null, domains: ['x.com'], ssoOnly: false });
    expect(describeSso({ jitRole: 'viewer', domains: ['x.com'], ssoOnly: true })).toBe(
      'new people join as viewer from x.com; SSO only',
    );
  });
});

describe('decideSso', () => {
  const id = { sub: 'sub-1', email: 'ann@acme.com', name: 'Ann' };
  const open: SsoSettings = { jitRole: 'viewer', domains: ['acme.com'], ssoOnly: false };
  const person = (over = {}) => ({ id: 'usr_1', externalSub: null, disabledAt: null, ...over });

  it('signs in the person linked to the subject, unless they are disabled', () => {
    expect(decideSso(id, person({ externalSub: 'sub-1' }), undefined, DEFAULT_SSO)).toEqual({
      kind: 'existing',
      userId: 'usr_1',
    });
    expect(decideSso(id, person({ disabledAt: 1 }), undefined, open).kind).toBe('refuse');
  });

  it('links a teammate by email once, never over another identity', () => {
    expect(decideSso(id, undefined, person(), DEFAULT_SSO)).toEqual({
      kind: 'link',
      userId: 'usr_1',
    });
    expect(decideSso(id, undefined, person({ externalSub: 'sub-2' }), open)).toEqual({
      kind: 'refuse',
      reason: 'email linked to another identity',
    });
    expect(decideSso({ ...id, email: null }, undefined, undefined, open)).toEqual({
      kind: 'refuse',
      reason: 'no verified email',
    });
  });

  it('adds someone new only when admins allow it and the domain is listed', () => {
    expect(decideSso(id, undefined, undefined, open)).toEqual({
      kind: 'create',
      role: 'viewer',
      email: 'ann@acme.com',
    });
    expect(decideSso(id, undefined, undefined, DEFAULT_SSO)).toEqual({
      kind: 'refuse',
      reason: 'not on the team',
    });
    expect(
      decideSso({ ...id, email: 'eve@acme.com.evil.test' }, undefined, undefined, open),
    ).toEqual({ kind: 'refuse', reason: 'domain not allowed' });
  });
});

describe('linking an identity to someone with a password', () => {
  const identity = { sub: 'idp|ann', email: 'ann@acme.com', name: 'Ann' };
  const ann = {
    id: 'usr_1',
    email: 'ann@acme.com',
    name: 'Ann',
    role: 'admin',
    externalSub: null,
    disabledAt: null,
  };
  const request = (cookie?: string) =>
    new Request('https://app.test/login/sso/link', cookie ? { headers: { cookie } } : {});

  afterEach(() => {
    rows.length = 0;
    writes.length = 0;
  });

  it('links someone without a password at once', async () => {
    rows.push(undefined, { ...ann, passwordHash: null });
    expect(await signInWithSso(request(), identity)).toEqual({ session: '__Host-ol_session=new' });
    expect(writes).toEqual([{ externalSub: 'idp|ann' }]);
  });

  it('waits for the password of someone who has one, and links only them', async () => {
    rows.push(undefined, { ...ann, passwordHash: 'pbkdf2$…' });
    const outcome = await signInWithSso(request(), identity);
    expect(writes).toEqual([]);
    if (!('confirmLink' in outcome)) throw new Error('expected a pending link');
    expect(outcome.confirmLink).toMatch(
      /^__Host-ol_sso_link=sl1\..*; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
    const cookie = outcome.confirmLink.split(';')[0]!;

    const user = { ...ann, passwordHash: 'pbkdf2$…', totpEnabledAt: null };
    rows.push(user);
    expect(await pendingSsoLink(request(cookie))).toMatchObject({ sub: 'idp|ann', user });
    // Gone once the person was linked another way, or lost their password.
    rows.push({ ...user, externalSub: 'idp|other' });
    expect(await pendingSsoLink(request(cookie))).toBeNull();
    rows.push({ ...user, passwordHash: null });
    expect(await pendingSsoLink(request(cookie))).toBeNull();
    rows.push({ ...user, disabledAt: 5 });
    expect(await pendingSsoLink(request(cookie))).toBeNull();
    expect(await pendingSsoLink(request('__Host-ol_sso_link=sl1.forged.sig'))).toBeNull();

    // Signed in as someone else: nothing is linked.
    rows.push(user);
    const bob = { kind: 'user' as const, id: 'usr_2', name: 'Bob', role: 'admin' as const };
    expect(await finishSsoLink(request(cookie), bob)).toBe(false);
    // Signed in as Ann, with her password: linked, unless the identity went to someone else.
    rows.push(user, { id: 'usr_3' });
    const caller = { kind: 'user' as const, id: 'usr_1', name: 'Ann', role: 'admin' as const };
    expect(await finishSsoLink(request(cookie), caller)).toBe(false);
    // Taken between the check and the write: the unique index refuses it, and so does the link.
    rows.push(user, undefined);
    failNextWrite = true;
    expect(await finishSsoLink(request(cookie), caller)).toBe(false);
    rows.push(user, undefined);
    expect(await finishSsoLink(request(cookie), caller)).toBe(true);
    expect(writes).toEqual([{ externalSub: 'idp|ann' }, { externalSub: 'idp|ann' }]);
  });
});

describe('the OpenID Connect flow', () => {
  let key: CryptoKey;
  let jwk: Record<string, unknown>;
  const calls: Request[] = [];
  let claims: Record<string, unknown> = {};
  let signWith: { audience?: string; issuer?: string } = {};

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey as CryptoKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
    claims = {};
    signWith = {};
  });

  /** The provider: discovery, keys, and a token endpoint that signs `claims` with the flow's nonce. */
  function provider(nonce: () => string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request.clone() as Request);
        const url = new URL(request.url);
        if (url.pathname === '/.well-known/openid-configuration')
          return Response.json({
            issuer: 'https://idp.test',
            authorization_endpoint: 'https://idp.test/authorize',
            token_endpoint: 'https://idp.test/token',
            jwks_uri: 'https://idp.test/keys',
          });
        if (url.pathname === '/keys') return Response.json({ keys: [jwk] });
        if (url.pathname === '/token') {
          const idToken = await new SignJWT({
            nonce: nonce(),
            email: 'ann@acme.com',
            email_verified: true,
            name: 'Ann',
            ...claims,
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setSubject('sub-1')
            .setIssuer(signWith.issuer ?? 'https://idp.test')
            .setAudience(signWith.audience ?? 'client-1')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(key);
          return Response.json({ id_token: idToken, token_type: 'Bearer' });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  }

  /** Starts a flow, then comes back the way the provider would redirect the browser. */
  async function roundTrip(
    tamper: (q: URLSearchParams) => void = () => {},
    reauth = false,
    forge: (flow: Record<string, unknown>) => void = () => {},
  ) {
    const c = ssoConfig()!;
    let flowNonce = '';
    provider(() => flowNonce);
    const start = await startSso(new Request('https://app.test/login/sso'), c, '/orders', reauth);
    const auth = new URL(start.location);
    flowNonce = auth.searchParams.get('nonce')!;
    const q = new URLSearchParams({ code: 'code-1', state: auth.searchParams.get('state')! });
    tamper(q);
    // A forger can read the sealed flow and edit it, but not sign the result.
    const [name, value] = start.cookie.split(';')[0]!.split(/=(.*)/s);
    const [version, payload, sig] = value!.split('.');
    const sealed = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/')));
    const before = JSON.stringify(sealed);
    forge(sealed.flow);
    const edited =
      JSON.stringify(sealed) === before
        ? value
        : `${version}.${btoa(JSON.stringify(sealed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${sig}`;
    const back = new Request(`https://app.test/login/sso/callback?${q}`, {
      headers: { cookie: `${name}=${edited}` },
    });
    return { auth, result: verifyCallback(back, c) };
  }

  it('sends a PKCE, state and nonce request and signs in who the token vouches for', async () => {
    const { auth, result } = await roundTrip();
    expect(auth.origin + auth.pathname).toBe('https://idp.test/authorize');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe('https://app.test/login/sso/callback');
    expect(await result).toEqual({
      identity: { sub: 'sub-1', email: 'ann@acme.com', name: 'Ann' },
      next: '/orders',
      reauthAt: null,
    });
    // An ordinary sign-in doesn't make the provider ask again.
    expect(auth.searchParams.has('prompt')).toBe(false);
    expect(auth.searchParams.has('max_age')).toBe(false);
    const token = calls.find((r) => r.url.endsWith('/token'))!;
    expect(token.headers.get('authorization')).toBe(`Basic ${btoa('client-1:s3cret')}`);
    const body = new URLSearchParams(await token.text());
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('refuses another state, a token for another client or issuer, and a stale nonce', async () => {
    await expect((await roundTrip((q) => q.set('state', 'forged'))).result).rejects.toThrow(
      /state mismatch/,
    );
    signWith = { audience: 'someone-else' };
    await expect((await roundTrip()).result).rejects.toBeInstanceOf(SsoError);
    signWith = { issuer: 'https://evil.test' };
    await expect((await roundTrip()).result).rejects.toBeInstanceOf(SsoError);
    signWith = {};
    claims = { nonce: 'replayed' };
    await expect((await roundTrip()).result).rejects.toThrow(/nonce mismatch/);
  });

  it('asks the provider to sign them in again for a step-up, and takes only a fresh sign-in', async () => {
    const now = Math.floor(Date.now() / 1000);
    claims = { auth_time: now };
    const { auth, result } = await roundTrip(undefined, true);
    expect(auth.searchParams.get('prompt')).toBe('login');
    expect(auth.searchParams.get('max_age')).toBe('0');
    expect((await result).reauthAt).toBeGreaterThan(0);
    // The provider answered from a sign-in before the step-up began, or didn't say when.
    claims = { auth_time: now - 30 * 60 };
    await expect((await roundTrip(undefined, true)).result).rejects.toThrow(/sign them in again/);
    claims = {};
    await expect((await roundTrip(undefined, true)).result).rejects.toThrow(/sign them in again/);
  });

  it('refuses a flow cookie the browser edited, or brought back after it expired', async () => {
    claims = { auth_time: Math.floor(Date.now() / 1000) - 30 * 60 };
    const earlier = (f: Record<string, unknown>) => {
      f.reauth = { at: 0 };
    };
    // A step-up whose start was moved back, and an ordinary sign-in made into one.
    await expect((await roundTrip(undefined, true, earlier)).result).rejects.toThrow(
      /no sign-in in progress/,
    );
    await expect((await roundTrip(undefined, false, earlier)).result).rejects.toThrow(
      /no sign-in in progress/,
    );
    claims = {};
    const { result } = await roundTrip(undefined, false, () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    });
    await expect(result).rejects.toThrow(/no sign-in in progress/);
    vi.restoreAllMocks();
  });

  it('keeps an unverified email from matching anyone', async () => {
    claims = { email_verified: false };
    expect((await (await roundTrip()).result).identity.email).toBeNull();
    // A token that leaves the claim out vouches for nothing, unless the deployment trusts its
    // provider's addresses (Entra ID: OIDC_TRUST_EMAIL).
    claims = { email_verified: undefined };
    expect((await (await roundTrip()).result).identity.email).toBeNull();
    env.OIDC_TRUST_EMAIL = 'true';
    try {
      expect((await (await roundTrip()).result).identity.email).toBe('ann@acme.com');
      // Entra's own word that the address's domain isn't verified still counts.
      claims = { email_verified: undefined, xms_edov: false };
      expect((await (await roundTrip()).result).identity.email).toBeNull();
    } finally {
      delete env.OIDC_TRUST_EMAIL;
    }
  });

  it('refuses a callback with no flow in this browser, or a provider error', async () => {
    const c = ssoConfig()!;
    await expect(
      verifyCallback(new Request('https://app.test/login/sso/callback?code=x&state=y'), c),
    ).rejects.toThrow(/no sign-in in progress/);
    await expect((await roundTrip((q) => q.set('error', 'access_denied'))).result).rejects.toThrow(
      /access_denied/,
    );
  });
});
