import { decodePrincipal, PRINCIPAL_HEADER, type Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Too many failed attempts.');
  }
}
class TokenExpired extends Error {}

const kv = new Map<string, string>();
const env = {
  OAUTH_KV: {
    get: async (k: string, type?: string) => {
      const v = kv.get(k) ?? null;
      return v && type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true }),
  },
};
const apiPrincipal = vi.fn();
const grantPrincipal = vi.fn();
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ fetch: engineFetch }) }));
vi.mock('~/lib/auth.server', () => ({
  apiPrincipal,
  grantPrincipal,
  Throttled,
  TokenExpired,
  TWO_FACTOR_DUE: 'Two-factor due',
}));

const { isOAuthPath, oauthProvider } = await import('~/lib/oauth.server');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const mcp = (headers: Record<string, string> = {}) =>
  oauthProvider('https://app.test').fetch(
    new Request('https://app.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    env as never,
    ctx,
  );

const token: Principal = { kind: 'token', id: 'tok_1', name: 'token:claude', role: 'viewer' };

describe('MCP on the web Worker', () => {
  beforeEach(() => {
    apiPrincipal.mockReset();
    grantPrincipal.mockReset();
    engineFetch.mockClear();
  });

  it('sends only MCP and OAuth protocol paths to the provider', () => {
    expect(isOAuthPath('/mcp')).toBe(true);
    expect(isOAuthPath('/.well-known/oauth-protected-resource/mcp')).toBe(true);
    expect(isOAuthPath('/oauth/token')).toBe(true);
    expect(isOAuthPath('/oauth/authorize')).toBe(false);
    expect(isOAuthPath('/api/v1/orders')).toBe(false);
  });

  it('challenges a request without a token, pointing at its resource metadata', async () => {
    const res = await mcp();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'https://app.test/.well-known/oauth-protected-resource/mcp',
    );
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('publishes the resource for this origin', async () => {
    const res = await oauthProvider('https://app.test').fetch(
      new Request('https://app.test/.well-known/oauth-protected-resource/mcp'),
      env as never,
      ctx,
    );
    expect(await res.json()).toMatchObject({ resource: 'https://app.test/mcp' });
  });

  it('forwards an API token caller to the engine without the credential', async () => {
    apiPrincipal.mockResolvedValueOnce(token);
    const res = await mcp({ authorization: 'Bearer ol_live_abc' });
    expect(res.status).toBe(200);
    const forwarded = engineFetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/mcp');
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(decodePrincipal(forwarded.headers.get(PRINCIPAL_HEADER))).toMatchObject(token);
  });

  it('refuses an unknown token', async () => {
    apiPrincipal.mockResolvedValueOnce(null);
    expect((await mcp({ authorization: 'Bearer ol_live_nope' })).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('passes on throttling and expiry', async () => {
    apiPrincipal.mockRejectedValueOnce(new Throttled(30_000));
    const throttled = await mcp({ authorization: 'Bearer guess' });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('30');

    apiPrincipal.mockRejectedValueOnce(new TokenExpired('This API token expired.'));
    expect((await mcp({ authorization: 'Bearer ol_live_old' })).status).toBe(401);
  });

  it('refuses a malformed Origin', async () => {
    apiPrincipal.mockResolvedValueOnce(token);
    const res = await mcp({ authorization: 'Bearer ol_live_abc', origin: 'null' });
    expect(res.status).toBe(403);
    expect(engineFetch).not.toHaveBeenCalled();
  });
});
