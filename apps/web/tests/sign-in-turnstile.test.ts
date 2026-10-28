import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};
vi.mock('cloudflare:workers', () => ({ env }));

class Throttled extends Error {
  retryAfterMs = 1000;
}
const signIn = vi.fn();
const signInDemo = vi.fn(async () => 'demo=1');
const startSession = vi.fn(async () => 'session=1');
vi.mock('~/lib/auth.server', () => ({
  authEnabled: async () => true,
  principal: async () => null,
  signIn,
  signInDemo,
  startSession,
  Throttled,
}));
let demo = false;
vi.mock('~/lib/demo.server', () => ({ isDemo: () => demo }));
vi.mock('~/lib/oauth.server', () => ({ oauthApi: () => ({ lookupClient: async () => null }) }));
vi.mock('~/lib/settings.server', () => ({ ssoOnlyInEffect: async () => false }));
vi.mock('~/lib/sso.server', () => ({ ssoConfig: () => null }));
const redeemSetupCode = vi.fn();
vi.mock('~/lib/setup.server', () => ({ redeemSetupCode, setupOpen: async () => true }));
class TeamError extends Error {}
vi.mock('~/lib/team.server', () => ({ TeamError }));

const login = await import('~/routes/login');
const setup = await import('~/routes/setup');
const { TURNSTILE_HEADER } = await import('~/lib/csp');

const siteverify = vi.fn();
const post = (path: string, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return {
    request: new Request(`https://acme.orderloop.app${path}`, {
      method: 'POST',
      body,
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }),
    params: {},
    context: {},
  } as never;
};
/** An action's answer: a redirect Response, or React Router's `data()` (or a plain object). */
const answer = (r: unknown) => {
  if (r instanceof Response) return { status: r.status, location: r.headers.get('location') };
  const d = r as { type?: string; data?: unknown; init?: { status?: number } };
  return d.type === 'DataWithResponseInit'
    ? { status: d.init?.status ?? 200, data: d.data }
    : { status: 200, data: r };
};
const credentials = { email: 'ada@example.com', password: 'correct horse battery' };
const setupFields = { code: 'code-1', ...credentials, name: 'Ada' };

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  demo = false;
  signIn.mockReset();
  signIn.mockResolvedValue({ cookie: 'session=1', twoFactor: false });
  redeemSetupCode.mockReset();
  redeemSetupCode.mockResolvedValue('usr_ada');
  siteverify.mockReset();
  vi.stubGlobal('fetch', siteverify);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('without Turnstile', () => {
  it('signs in and sets up as before, asking no one', async () => {
    expect(answer(await login.action(post('/login', credentials)))).toMatchObject({
      status: 302,
    });
    expect(signIn).toHaveBeenCalledOnce();
    expect(answer(await setup.action(post('/setup', setupFields)))).toMatchObject({
      status: 302,
      location: '/team',
    });
    expect(siteverify).not.toHaveBeenCalled();
    expect(await setup.loader()).toMatchObject({ turnstile: null });
    // No page asks the browser to allow Turnstile.
    const headers = login.headers({ actionHeaders: new Headers() } as never) as Headers;
    expect(headers.has(TURNSTILE_HEADER)).toBe(false);
  });
});

describe('with Turnstile', () => {
  beforeEach(() => {
    env.TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    env.TURNSTILE_SECRET_KEY = 's3cret';
  });
  const passes = (action: string) =>
    siteverify.mockResolvedValueOnce(
      Response.json({ success: true, hostname: 'acme.orderloop.app', action }),
    );

  it('checks the token before the password, and signs in when it passed', async () => {
    passes('login');
    const r = answer(
      await login.action(post('/login', { ...credentials, 'cf-turnstile-response': 'tok' })),
    );
    expect(r).toMatchObject({ status: 302 });
    expect(siteverify).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledOnce();
  });

  it('refuses a sign-in without a token, or with a failed one, and never checks the password', async () => {
    expect(answer(await login.action(post('/login', credentials)))).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/Complete the check/) },
    });
    siteverify.mockResolvedValueOnce(
      Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    expect(
      answer(
        await login.action(post('/login', { ...credentials, 'cf-turnstile-response': 'old' })),
      ),
    ).toMatchObject({ status: 403 });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('refuses a sign-in when Siteverify can’t be reached', async () => {
    siteverify.mockRejectedValueOnce(new TypeError('network down'));
    expect(
      answer(
        await login.action(post('/login', { ...credentials, 'cf-turnstile-response': 'tok' })),
      ),
    ).toMatchObject({ status: 503 });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('leaves the demo’s one-click sign-in alone', async () => {
    demo = true;
    expect(answer(await login.action(post('/login', { intent: 'demo' })))).toMatchObject({
      status: 302,
    });
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('creates the first admin only with a token solved for setup', async () => {
    expect(answer(await setup.action(post('/setup', setupFields)))).toMatchObject({
      status: 400,
    });
    // A sign-in page's token can't set up.
    passes('login');
    expect(
      answer(
        await setup.action(post('/setup', { ...setupFields, 'cf-turnstile-response': 'tok' })),
      ),
    ).toMatchObject({ status: 403 });
    expect(redeemSetupCode).not.toHaveBeenCalled();
    passes('setup');
    expect(
      answer(
        await setup.action(post('/setup', { ...setupFields, 'cf-turnstile-response': 'tok' })),
      ),
    ).toMatchObject({ status: 302, location: '/team' });
    expect(redeemSetupCode).toHaveBeenCalledOnce();
  });

  it('refuses everything when the secret is missing', async () => {
    delete env.TURNSTILE_SECRET_KEY;
    expect(
      answer(
        await login.action(post('/login', { ...credentials, 'cf-turnstile-response': 'tok' })),
      ),
    ).toMatchObject({ status: 503 });
    expect(signIn).not.toHaveBeenCalled();
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('gives the pages the site key and lets them, and only them, load Turnstile', async () => {
    expect(await setup.loader()).toMatchObject({ turnstile: '0x4AAAAAAAtest' });
    for (const route of [login, setup]) {
      const headers = route.headers({
        actionHeaders: new Headers({ 'retry-after': '3' }),
      } as never) as Headers;
      expect(headers.get(TURNSTILE_HEADER)).toBe('1');
      expect(headers.get('retry-after')).toBe('3');
    }
  });
});
