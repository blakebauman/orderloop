import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};
vi.mock('cloudflare:workers', () => ({ env }));

const { siteverify, checkTurnstile, withTurnstilePolicy, TOKEN_FIELD } = await import(
  '~/lib/turnstile.server'
);
const { TURNSTILE_HEADER } = await import('~/lib/csp');

/** A Siteverify that answers `body` (or fails), recording what it was sent. */
function fakeSiteverify(body: unknown, init: ResponseInit = { status: 200 }) {
  const sent: URLSearchParams[] = [];
  const fetcher = vi.fn(async (_url: unknown, req?: RequestInit) => {
    sent.push(req?.body as URLSearchParams);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
  });
  return { fetcher: fetcher as unknown as typeof fetch, sent, calls: fetcher };
}

const passed = { success: true, hostname: 'acme.orderloop.app', action: 'login' };
const input = {
  secret: 's3cret',
  token: 'tok',
  remoteip: '203.0.113.7',
  action: 'login' as const,
  hostname: 'acme.orderloop.app',
};

describe('siteverify', () => {
  it('accepts a token that passed for this action on this host, and sends who asked', async () => {
    const { fetcher, sent, calls } = fakeSiteverify(passed);
    expect(await siteverify(input, fetcher)).toEqual({ ok: true });
    expect(calls).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(Object.fromEntries(sent[0]!)).toEqual({
      secret: 's3cret',
      response: 'tok',
      remoteip: '203.0.113.7',
    });
  });

  it('refuses a token Siteverify failed', async () => {
    const { fetcher } = fakeSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await siteverify(input, fetcher)).toEqual({
      ok: false,
      reason: 'failed:timeout-or-duplicate',
    });
  });

  it('refuses a token solved on another host, even a subdomain the widget also covers', async () => {
    const { fetcher } = fakeSiteverify({ ...passed, hostname: 'demo.orderloop.app' });
    expect(await siteverify(input, fetcher)).toEqual({ ok: false, reason: 'wrong-hostname' });
  });

  it('refuses a token solved for the other form', async () => {
    const { fetcher } = fakeSiteverify({ ...passed, action: 'setup' });
    expect(await siteverify(input, fetcher)).toEqual({ ok: false, reason: 'wrong-action' });
  });

  it('fails closed when Siteverify is unreachable, errors or answers nonsense', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await siteverify(input, down)).toEqual({
      ok: false,
      reason: 'siteverify-unreachable',
    });
    expect(await siteverify(input, fakeSiteverify('bad gateway', { status: 502 }).fetcher)).toEqual(
      { ok: false, reason: 'siteverify-502' },
    );
    expect(await siteverify(input, fakeSiteverify('<html>').fetcher)).toEqual({
      ok: false,
      reason: 'siteverify-unreachable',
    });
    expect(await siteverify(input, fakeSiteverify({ success: 'yes' }).fetcher)).toMatchObject({
      ok: false,
    });
  });

  it('never asks about a missing or oversized token', async () => {
    const { fetcher, calls } = fakeSiteverify(passed);
    expect(await siteverify({ ...input, token: '' }, fetcher)).toEqual({
      ok: false,
      reason: 'no-token',
    });
    expect(await siteverify({ ...input, token: 'x'.repeat(2049) }, fetcher)).toMatchObject({
      ok: false,
    });
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('checkTurnstile', () => {
  const post = (fields: Record<string, string> = { [TOKEN_FIELD]: 'tok' }) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const request = new Request('https://acme.orderloop.app/login', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    return [request, form] as const;
  };
  let error: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
    log.mockRestore();
  });

  it('checks nothing on a deployment without a site key', async () => {
    const { fetcher, calls } = fakeSiteverify(passed);
    expect(await checkTurnstile(...post({}), 'login', fetcher)).toBeNull();
    expect(calls).not.toHaveBeenCalled();
    expect(withTurnstilePolicy(new Headers()).has(TURNSTILE_HEADER)).toBe(false);
  });

  it('checks the token against the host it was posted to, and the caller’s address', async () => {
    env.TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    env.TURNSTILE_SECRET_KEY = 's3cret';
    const { fetcher, sent } = fakeSiteverify(passed);
    expect(await checkTurnstile(...post(), 'login', fetcher)).toBeNull();
    expect(sent[0]!.get('remoteip')).toBe('203.0.113.7');
    expect(withTurnstilePolicy(new Headers({ 'retry-after': '3' })).get(TURNSTILE_HEADER)).toBe(
      '1',
    );
  });

  it('tells the person what to do when the check is missing, failed or unconfirmed', async () => {
    env.TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    env.TURNSTILE_SECRET_KEY = 's3cret';
    expect(await checkTurnstile(...post({}), 'login', fakeSiteverify(passed).fetcher)).toEqual({
      error: expect.stringMatching(/Complete the check/),
      status: 400,
    });
    expect(await checkTurnstile(...post(), 'setup', fakeSiteverify(passed).fetcher)).toMatchObject({
      status: 403,
    });
    expect(
      await checkTurnstile(...post(), 'login', fakeSiteverify('', { status: 500 }).fetcher),
    ).toMatchObject({ status: 503 });
  });

  it('refuses everything when the site key has no secret, rather than skipping the check', async () => {
    env.TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    const { fetcher, calls } = fakeSiteverify(passed);
    expect(await checkTurnstile(...post(), 'setup', fetcher)).toEqual({
      error: expect.stringMatching(/Setting up is unavailable/),
      status: 503,
    });
    expect(calls).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('turnstile_misconfigured'));
  });
});
