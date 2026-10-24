import { type PluginManifest, PRINCIPAL_HEADER, verifyPrincipal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pluginFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));
const env: Record<string, unknown> = {
  PRINCIPAL_KEY: 'web-test-key',
  PLUGIN_EXAMPLE: { fetch: pluginFetch },
};
const manifest: PluginManifest = {
  id: 'example',
  name: 'Example',
  version: '1',
  nodes: [],
  events: [],
  nav: [],
  publicPaths: ['/plugins/example/public/ping'],
  requires: [],
};
const pluginCatalog = vi.fn(async () => [manifest]);
let caller: Record<string, unknown> | null;

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ pluginCatalog }) }));
vi.mock('~/lib/auth.server', () => ({
  principal: async () => caller,
  sessionId: async () => 'sess-hash',
  setupDue: () => null,
}));

const { pluginFetch: forward } = await import('~/lib/plugins.server');

const call = (path: string, headers: Record<string, string> = {}) =>
  forward(new Request(`https://shop.example${path}`, { headers }));
const sent = () => pluginFetch.mock.calls.at(-1)![0];

describe('plugin pages on the web Worker', () => {
  beforeEach(() => {
    pluginFetch.mockClear();
    caller = { kind: 'user', id: 'usr_1', name: 'Ada', role: 'admin' };
  });

  it('forwards a signed-in person with a signed principal and no credentials', async () => {
    const res = await call('/plugins/example/', { cookie: 'session=abc', authorization: 'x' });
    expect(res.status).toBe(200);
    const req = sent();
    expect(new URL(req.url).pathname).toBe('/plugins/example/');
    expect(req.headers.get('cookie')).toBeNull();
    expect(req.headers.get('authorization')).toBeNull();
    const p = await verifyPrincipal(
      ['web-test-key'],
      req.headers.get(PRINCIPAL_HEADER),
      '/plugins/example/',
    );
    expect(p).toMatchObject({ id: 'usr_1', role: 'admin', session: 'sess-hash' });
  });

  it('refuses a page to someone not signed in', async () => {
    caller = null;
    expect((await call('/plugins/example/')).status).toBe(401);
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it('forwards a public path without a principal', async () => {
    caller = null;
    expect((await call('/plugins/example/public/ping')).status).toBe(200);
    expect(sent().headers.get(PRINCIPAL_HEADER)).toBeNull();
  });

  it('answers 404 for a plugin that is not installed', async () => {
    expect((await call('/plugins/ledger/')).status).toBe(404);
    expect(pluginFetch).not.toHaveBeenCalled();
  });
});
