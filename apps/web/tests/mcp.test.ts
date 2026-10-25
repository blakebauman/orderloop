import { PRINCIPAL_HEADER, type Principal, verifyPrincipal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Too many failed attempts.');
  }
}
class TokenExpired extends Error {}

const kv = new Map<string, string>();
const env = {
  PRINCIPAL_KEY: 'web-test-key',
  OAUTH_KV: {
    get: async (k: string, type?: string | { type?: string }) => {
      const v = kv.get(k) ?? null;
      const json = type === 'json' || (typeof type === 'object' && type.type === 'json');
      return v && json ? JSON.parse(v) : v;
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
  setupDue: (c: { twoFactorDue?: true; passwordChangeDue?: true }) =>
    c.passwordChangeDue ? 'Password change due' : c.twoFactorDue ? 'Two-factor due' : null,
}));

const { isOAuthPath, oauthApi, oauthFetch, scopedGrant } = await import('~/lib/oauth.server');
const { mcpDiscovery } = await import('~/lib/mcp-discovery');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const post = (path: string, headers: Record<string, string> = {}) =>
  oauthFetch(
    new Request(`https://app.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    env as never,
    ctx,
  );
const mcp = (headers: Record<string, string> = {}) => post('/mcp', headers);

const token: Principal = { kind: 'token', id: 'tok_1', name: 'token:claude', role: 'viewer' };

describe('MCP and A2A on the web Worker', () => {
  beforeEach(() => {
    apiPrincipal.mockReset();
    grantPrincipal.mockReset();
    engineFetch.mockClear();
  });

  it('sends only MCP, A2A and OAuth protocol paths to the provider', () => {
    expect(isOAuthPath('/mcp')).toBe(true);
    expect(isOAuthPath('/a2a')).toBe(true);
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
    // The roles an app can be granted, never admin.
    expect(res.headers.get('www-authenticate')).toContain('scope="viewer approver operator"');
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('publishes the resource for this origin', async () => {
    for (const path of ['/mcp', '/a2a']) {
      const res = await oauthFetch(
        new Request(`https://app.test/.well-known/oauth-protected-resource${path}`),
        env as never,
        ctx,
      );
      expect(await res.json()).toMatchObject({
        resource: `https://app.test${path}`,
        authorization_servers: ['https://app.test'],
        scopes_supported: ['viewer', 'approver', 'operator'],
      });
    }
  });

  it('forwards an API token caller to the engine without the credential', async () => {
    apiPrincipal.mockResolvedValueOnce(token);
    const res = await mcp({ authorization: 'Bearer ol_live_abc' });
    expect(res.status).toBe(200);
    const forwarded = engineFetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/mcp');
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(
      await verifyPrincipal([env.PRINCIPAL_KEY], forwarded.headers.get(PRINCIPAL_HEADER), '/mcp'),
    ).toMatchObject(token);
  });

  it('passes the 2026-07-28 request headers on to the engine', async () => {
    apiPrincipal.mockResolvedValueOnce(token);
    await mcp({
      authorization: 'Bearer ol_live_abc',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'get_order',
    });
    const forwarded = engineFetch.mock.calls[0]![0];
    expect(forwarded.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(forwarded.headers.get('mcp-method')).toBe('tools/call');
    expect(forwarded.headers.get('mcp-name')).toBe('get_order');
  });

  it('refuses a caller who must choose their own password or set up two-factor first', async () => {
    apiPrincipal.mockResolvedValueOnce({ ...token, passwordChangeDue: true });
    const res = await mcp({ authorization: 'Bearer ol_live_abc' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Password change due' });
    apiPrincipal.mockResolvedValueOnce({ ...token, twoFactorDue: true });
    expect((await mcp({ authorization: 'Bearer ol_live_abc' })).status).toBe(403);
    expect(engineFetch).not.toHaveBeenCalled();
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

  it('advertises both resources from one authorization server', async () => {
    const res = await oauthFetch(
      new Request('https://app.test/.well-known/oauth-authorization-server'),
      env as never,
      ctx,
    );
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe('https://app.test');
    expect(meta.protected_resources).toEqual(['https://app.test/mcp', 'https://app.test/a2a']);
  });

  it('challenges /a2a with its own resource and forwards a token caller there', async () => {
    const challenged = await post('/a2a');
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toContain(
      'https://app.test/.well-known/oauth-protected-resource/a2a',
    );

    apiPrincipal.mockResolvedValueOnce(token);
    const res = await post('/a2a', { authorization: 'Bearer ol_live_abc' });
    expect(res.status).toBe(200);
    const forwarded = engineFetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/a2a');
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(
      await verifyPrincipal([env.PRINCIPAL_KEY], forwarded.headers.get(PRINCIPAL_HEADER), '/a2a'),
    ).toMatchObject(token);
  });

  it('binds an OAuth token to the endpoint it was granted for', async () => {
    const oauth = oauthApi(new Request('https://app.test/oauth/authorize'));
    const client = await oauth.createClient({
      redirectUris: ['https://client.test/cb'],
      tokenEndpointAuthMethod: 'none',
    });
    const verifier = 'v'.repeat(64);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const grant = async (path: string, role: 'viewer' | 'operator' = 'viewer') => {
      const { redirectTo } = await oauth.completeAuthorization({
        request: {
          responseType: 'code',
          clientId: client.clientId,
          redirectUri: 'https://client.test/cb',
          scope: ['viewer'],
          state: 's',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          resource: `https://app.test${path}`,
        },
        userId: 'usr_1',
        metadata: {},
        scope: ['viewer'],
        props: { kind: 'user', id: 'usr_1', role },
      });
      const code = new URL(redirectTo).searchParams.get('code')!;
      const res = await oauthFetch(
        new Request('https://app.test/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'https://client.test/cb',
            client_id: client.clientId,
            code_verifier: verifier,
          }),
        }),
        env as never,
        ctx,
      );
      return ((await res.json()) as { access_token: string }).access_token;
    };
    const person = { ...token, kind: 'user' as const, id: 'usr_1' };
    grantPrincipal.mockResolvedValue(person);

    const mcpToken = await grant('/mcp');
    expect((await post('/mcp', { authorization: `Bearer ${mcpToken}` })).status).toBe(200);
    expect((await post('/a2a', { authorization: `Bearer ${mcpToken}` })).status).toBe(401);

    const a2aToken = await grant('/a2a');
    expect((await post('/a2a', { authorization: `Bearer ${a2aToken}` })).status).toBe(200);
    expect((await post('/mcp', { authorization: `Bearer ${a2aToken}` })).status).toBe(401);
    expect(apiPrincipal).not.toHaveBeenCalled();

    // A token whose scope is narrower than its grant acts with the scope's role.
    grantPrincipal.mockClear();
    const narrow = await grant('/mcp', 'operator');
    expect((await post('/mcp', { authorization: `Bearer ${narrow}` })).status).toBe(200);
    expect(grantPrincipal).toHaveBeenCalledWith({ kind: 'user', id: 'usr_1', role: 'viewer' });
  });

  it('gives a token the lowest role its scope names, never more than the grant', () => {
    const g = { kind: 'user' as const, id: 'usr_1', role: 'operator' as const };
    expect(scopedGrant(g, ['operator'])).toEqual(g);
    expect(scopedGrant(g, ['viewer'])).toEqual({ ...g, role: 'viewer' });
    expect(scopedGrant(g, ['approver', 'operator'])).toEqual({ ...g, role: 'approver' });
    expect(scopedGrant({ ...g, role: 'viewer' }, ['operator'])).toEqual({ ...g, role: 'viewer' });
    expect(scopedGrant(g, [])).toBeNull();
    expect(scopedGrant(g, ['admin:everything'])).toBeNull();
  });
});

describe('MCP discovery', () => {
  const get = (path: string, init: RequestInit = {}) =>
    mcpDiscovery(new Request(`https://orderloop.app${path}`, init));

  it('publishes a Server Card for this origin, with no capabilities or tools', async () => {
    const res = (await get('/mcp/server-card'))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/mcp-server-card+json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const card = (await res.json()) as { name: string; description: string };
    expect(card).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: 'app.orderloop/mcp',
      version: expect.any(String),
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://orderloop.app/mcp',
          supportedProtocolVersions: expect.arrayContaining(['2026-07-28', '2025-06-18']),
        },
      ],
    });
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(card).not.toHaveProperty('capabilities');
    expect(card).not.toHaveProperty('tools');
  });

  it('lists the card in the AI Catalog', async () => {
    const res = (await get('/.well-known/ai-catalog.json'))!;
    expect(res.headers.get('content-type')).toBe('application/ai-catalog+json');
    expect(await res.json()).toEqual({
      specVersion: '1.0',
      entries: [
        {
          identifier: 'urn:air:orderloop.app:mcp:orderloop',
          type: 'application/mcp-server-card+json',
          url: 'https://orderloop.app/mcp/server-card',
        },
      ],
    });
  });

  it('revalidates by ETag, answers preflight and only reads', async () => {
    const etag = (await get('/mcp/server-card'))!.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await get('/mcp/server-card', { headers: { 'if-none-match': etag } }))!.status).toBe(
      304,
    );
    expect((await get('/mcp/server-card', { method: 'OPTIONS' }))!.status).toBe(204);
    expect((await get('/mcp/server-card', { method: 'POST' }))!.status).toBe(405);
    expect(await get('/mcp')).toBeNull();
    expect(isOAuthPath('/mcp/server-card')).toBe(false);
  });
});
