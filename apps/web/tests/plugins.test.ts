import {
  type PluginManifest,
  type PluginStatus,
  PRINCIPAL_HEADER,
  pluginKey,
  verifyPrincipal,
} from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Headers a hostile or buggy plugin might send, none of which may reach the browser. */
const HOSTILE = {
  'set-cookie': 'session=stolen; Path=/',
  'x-frame-options': 'ALLOWALL',
  'content-security-policy': "script-src 'unsafe-inline' https://evil.example",
  connection: 'keep-alive',
  'service-worker-allowed': '/',
  'strict-transport-security': 'max-age=0',
  nel: '{"report_to":"x","max_age":86400}',
  'report-to': '{"group":"x","endpoints":[{"url":"https://evil.example"}]}',
  'reporting-endpoints': 'x="https://evil.example"',
  'clear-site-data': '"*"',
  'permissions-policy': 'camera=*',
  'access-control-allow-origin': '*',
};
let reply: () => Response = () =>
  Response.json({ ok: true }, { headers: { ...HOSTILE, 'cache-control': 'no-store' } });
const pluginFetch = vi.fn(async (_r: Request) => reply());
const env: Record<string, unknown> = {
  PRINCIPAL_KEY: 'web-test-key',
  PLUGIN_EXAMPLE: { fetch: pluginFetch },
};
const manifest: PluginManifest = {
  apiVersion: 1,
  id: 'example',
  name: 'Example',
  version: '1',
  nodes: [],
  events: [],
  nav: [],
  publicPaths: ['/plugins/example/public/ping'],
  requires: [],
  pageRole: 'operator',
  personalData: 'redact',
  secrets: [],
  provides: [],
  egress: [],
  limits: {},
  capabilities: [],
};
const sandboxedManifest: PluginManifest = { ...manifest, id: 'sbx', publicPaths: [] };
const pluginCatalog = vi.fn(
  async (): Promise<PluginStatus[]> => [
    { id: 'example', runtime: 'worker', source: 'deployment', manifest, healthy: true },
    {
      id: 'sbx',
      runtime: 'sandboxed',
      source: 'deployment',
      manifest: sandboxedManifest,
      healthy: true,
    },
  ],
);
// The engine serves a sandboxed plugin's pages (EngineRpc.pluginFetch).
const enginePluginFetch = vi.fn(async (_id: string, _r: Request) => reply());
let caller: Record<string, unknown> | null;
let limited = false;

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ pluginCatalog, pluginFetch: enginePluginFetch }),
}));
vi.mock('~/lib/auth.server', () => ({
  principal: async () => caller,
  sessionId: async () => 'sess-hash',
  setupDue: () => null,
}));
vi.mock('~/lib/audit.server', () => ({ clientIp: () => '203.0.113.7' }));
const overBudget = vi.fn(async (_budget: string, _key: string) =>
  limited ? new Response('Too many requests', { status: 429 }) : null,
);
vi.mock('~/lib/rate-limit', () => ({ overBudget }));

const {
  pluginFetch: forward,
  pluginPathId,
  MAX_PLUGIN_BODY,
} = await import('~/lib/plugins.server');

const call = (path: string, init: RequestInit = {}) =>
  forward(new Request(`https://shop.example${path}`, init));
const sent = () => pluginFetch.mock.calls.at(-1)![0];

describe('plugin pages on the web Worker', () => {
  beforeEach(() => {
    pluginFetch.mockClear();
    overBudget.mockClear();
    limited = false;
    caller = { kind: 'user', id: 'usr_1', name: 'Ada', role: 'admin' };
  });

  it('forwards a signed-in person with a signed principal and only the allowed headers', async () => {
    const res = await call('/plugins/example/', {
      headers: {
        cookie: 'session=abc',
        authorization: 'Bearer x',
        'x-forwarded-for': '10.0.0.1',
        'cf-connecting-ip': '203.0.113.7',
        accept: 'text/html',
      },
    });
    expect(res.status).toBe(200);
    const req = sent();
    expect(new URL(req.url).pathname).toBe('/plugins/example/');
    expect([...req.headers.keys()].sort()).toEqual(['accept', PRINCIPAL_HEADER]);
    const header = req.headers.get(PRINCIPAL_HEADER);
    // Signed with the plugin's own key, which the engine (the principal key) doesn't accept.
    const p = await verifyPrincipal(
      [await pluginKey('web-test-key', 'example')],
      header,
      '/plugins/example/',
    );
    expect(p).toMatchObject({ id: 'usr_1', role: 'admin' });
    expect(p).not.toHaveProperty('session');
    expect(await verifyPrincipal(['web-test-key'], header, '/plugins/example/')).toBeNull();
    expect(overBudget).toHaveBeenCalledWith('API_LIMIT', 'plugin:example:usr_1');
  });

  it('sends a sandboxed plugin’s pages through the engine, under the same rules', async () => {
    const res = await call('/plugins/sbx/', {
      headers: { cookie: 'session=abc', accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    expect(enginePluginFetch).toHaveBeenCalledTimes(1);
    const [id, req] = enginePluginFetch.mock.calls[0]!;
    expect(id).toBe('sbx');
    expect([...req.headers.keys()].sort()).toEqual(['accept', PRINCIPAL_HEADER]);
    const p = await verifyPrincipal(
      [await pluginKey('web-test-key', 'sbx')],
      req.headers.get(PRINCIPAL_HEADER),
      '/plugins/sbx/',
    );
    expect(p).toMatchObject({ id: 'usr_1' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    // Its forms post only to its own pages, never to /plugins (where plugins are installed).
    expect(res.headers.get('content-security-policy')).toMatch(
      /; form-action https?:\/\/[^/ ]+\/plugins\/sbx\/$/,
    );
  });

  it("passes on only allowlisted response headers, under this app's rules", async () => {
    const res = await call('/plugins/example/');
    for (const h of Object.keys(HOSTILE).filter(
      (k) => k !== 'x-frame-options' && k !== 'content-security-policy',
    ))
      expect(res.headers.get(h), h).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('evil.example');
  });

  it("keeps a plugin's redirects within its own pages", async () => {
    reply = () => new Response(null, { status: 302, headers: { location: 'next?x=1' } });
    const inside = await call('/plugins/example/form');
    expect(inside.status).toBe(302);
    expect(inside.headers.get('location')).toBe('/plugins/example/next?x=1');
    for (const away of [
      'https://evil.example/',
      '/account',
      '//evil.example/x',
      '/plugins/other/',
    ]) {
      reply = () => new Response(null, { status: 302, headers: { location: away } });
      expect((await call('/plugins/example/form')).status, away).toBe(502);
    }
    reply = () => Response.json({ ok: true });
  });

  it('refuses a page to someone not signed in, or below its page role', async () => {
    caller = null;
    expect((await call('/plugins/example/')).status).toBe(401);
    caller = { kind: 'user', id: 'usr_2', name: 'Vi', role: 'viewer' };
    expect((await call('/plugins/example/')).status).toBe(403);
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it('forwards a public path without a principal, within its rate limit', async () => {
    caller = null;
    expect((await call('/plugins/example/public/ping')).status).toBe(200);
    expect(sent().headers.get(PRINCIPAL_HEADER)).toBeNull();
    expect(overBudget).toHaveBeenCalledWith('WEBHOOK_LIMIT', 'plugin:example:203.0.113.7');
    limited = true;
    expect((await call('/plugins/example/public/ping')).status).toBe(429);
  });

  it('refuses a body over the limit, declared or streamed', async () => {
    const declared = await call('/plugins/example/public/ping', {
      method: 'POST',
      headers: { 'content-length': String(MAX_PLUGIN_BODY + 1) },
      body: 'x',
    });
    expect(declared.status).toBe(413);
    expect(pluginFetch).not.toHaveBeenCalled();

    await call('/plugins/example/public/ping', {
      method: 'POST',
      body: new Blob([new Uint8Array(MAX_PLUGIN_BODY + 1)]).stream(),
      duplex: 'half',
    } as RequestInit);
    await expect(sent().arrayBuffer()).rejects.toThrow(/too large/);
  });

  it('forwards only /plugins/<id>/ paths, and answers 404 for a plugin not installed', async () => {
    expect(pluginPathId('/plugins')).toBeNull();
    expect(pluginPathId('/plugins/')).toBeNull();
    expect(pluginPathId('/plugins/Bad_Id/x')).toBeNull();
    expect(pluginPathId('/plugins/example/x')).toBe('example');
    expect((await call('/plugins/ledger/')).status).toBe(404);
    expect(pluginFetch).not.toHaveBeenCalled();
  });
});
