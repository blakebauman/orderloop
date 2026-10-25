import { PLUGIN_VIEW_TYPE, type PluginView } from '@orderloop/core';
import type { RouterContextProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { PRINCIPAL_KEY: 'web-test-key' };
let reply: () => Response;
const pluginFetch = vi.fn(async (_r: Request) => reply());
// What React Router was asked to render, and with which context.
const rendered = vi.fn(
  async (_r: Request, _c?: RouterContextProvider) => new Response('<html>shell</html>'),
);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  createRequestHandler: () => rendered,
}));
vi.mock('~/lib/env.server', () => ({ engine: () => ({}), db: () => ({}), docs: () => ({}) }));
vi.mock('~/lib/auth.server', () => ({
  principal: async () => null,
  apiPrincipal: vi.fn(),
  awaitingSetup: async () => false,
  sessionId: async () => 'ses_1',
  setupDue: () => null,
  Throttled: class extends Error {},
  TokenExpired: class extends Error {},
  cookie: () => undefined,
}));
vi.mock('~/lib/plugins.server', () => ({
  pluginFetch,
  pluginPathId: (p: string) => /^\/plugins\/([a-z0-9-]+)\//.exec(p)?.[1] ?? null,
  unalias: (p: string) =>
    p.startsWith('/punchout/') ? `/plugins/punchout/${p.slice('/punchout/'.length)}` : null,
}));

const { default: worker } = await import('../workers/app');
const { pluginPageContext } = await import('../app/lib/plugin-view');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://app.test${path}`, init) as never, env as never, ctx);
const view: PluginView = {
  title: 'Partners',
  blocks: [{ type: 'form', action: 'partners', fields: [], submit: 'Add' }],
};
const asView = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': PLUGIN_VIEW_TYPE } });
const page = { accept: 'text/html' };

describe('a plugin page answered with a view', () => {
  beforeEach(() => {
    pluginFetch.mockClear();
    rendered.mockClear();
    reply = () => asView(view);
  });

  it('is drawn in the app shell, as a GET of the same address', async () => {
    const res = await call('/plugins/punchout/?x=1', { headers: page });
    expect(await res.text()).toBe('<html>shell</html>');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const [req, context] = rendered.mock.calls[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://app.test/plugins/punchout/?x=1');
    expect(context!.get(pluginPageContext)).toMatchObject({
      pluginId: 'punchout',
      base: '/plugins/punchout/',
      view: { title: 'Partners', blocks: [{ type: 'form', tone: 'default' }] },
      error: null,
      status: 200,
    });
  });

  it('draws the answer to a form post, keeping the plugin’s status', async () => {
    reply = () => asView(view, 400);
    await call('/plugins/punchout/partners', {
      method: 'POST',
      headers: {
        ...page,
        'sec-fetch-dest': 'document',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'name=x',
    });
    expect(pluginFetch.mock.calls[0]![0].method).toBe('POST');
    const [req, context] = rendered.mock.calls[0]!;
    expect(req.method).toBe('GET');
    expect(req.headers.get('content-type')).toBeNull();
    expect(context!.get(pluginPageContext)).toMatchObject({ status: 400, error: null });
  });

  it('says why a view it can’t draw was refused, and never draws its contents', async () => {
    reply = () =>
      asView({
        title: 'X',
        blocks: [{ type: 'list', items: [{ label: 'x', href: 'javascript:1' }] }],
      });
    await call('/plugins/punchout/', { headers: page });
    const got = rendered.mock.calls[0]![1]!.get(pluginPageContext)!;
    expect(got.view).toBeNull();
    expect(got.error).toMatch(/^blocks\.0\.items\.0/);
  });

  it('goes back as it is when no browser asked for a page, or it isn’t a view', async () => {
    const json = await call('/plugins/punchout/', { headers: { accept: 'application/json' } });
    expect(json.headers.get('content-type')).toBe(PLUGIN_VIEW_TYPE);
    const fetched = await call('/plugins/punchout/partners', {
      method: 'POST',
      headers: { ...page, 'sec-fetch-dest': 'empty' },
    });
    expect(fetched.headers.get('content-type')).toBe(PLUGIN_VIEW_TYPE);
    reply = () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } });
    expect(await (await call('/plugins/punchout/', { headers: page })).text()).toBe('<p>hi</p>');
    expect(rendered).not.toHaveBeenCalled();
  });

  it('sends a browser on an alias to the plugin’s own address, where the app’s routes are', async () => {
    const res = await call('/punchout/partners?x=1', { headers: page });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/plugins/punchout/partners?x=1');
    expect(rendered).not.toHaveBeenCalled();
    // Anything else on the alias is answered as it is.
    reply = () => new Response('<cXML/>', { headers: { 'content-type': 'text/xml' } });
    expect(await (await call('/punchout/cxml/setup', { method: 'POST', body: 'x' })).text()).toBe(
      '<cXML/>',
    );
  });

  it('never lets a plugin answer a route-data request, which would skip the check', async () => {
    for (const [path, to] of [
      ['/plugins/punchout/_.data?_routes=routes/plugin-page', '/plugins/punchout/'],
      ['/plugins/punchout/partners.data?x=1', '/plugins/punchout/partners?x=1'],
    ]) {
      const res = await call(path!, { headers: page });
      expect(res.status).toBe(204);
      expect(res.headers.get('x-remix-redirect')).toBe(to);
      expect(res.headers.get('x-remix-reload-document')).toBe('true');
    }
    expect(pluginFetch).not.toHaveBeenCalled();
    expect(rendered).not.toHaveBeenCalled();
  });

  it('refuses a view over the size cap, declared or streamed, without reading it all', async () => {
    reply = () =>
      new Response('{}', {
        headers: { 'content-type': PLUGIN_VIEW_TYPE, 'content-length': String(10 * 1024 * 1024) },
      });
    await call('/plugins/punchout/', { headers: page });
    expect(rendered.mock.calls[0]![1]!.get(pluginPageContext)).toMatchObject({
      view: null,
      error: 'The page is too large',
    });
    let pulled = 0;
    reply = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(64 * 1024));
            if (pulled > 1000) c.close();
          },
        }),
        { headers: { 'content-type': PLUGIN_VIEW_TYPE } },
      );
    await call('/plugins/punchout/', { headers: page });
    expect(rendered.mock.calls[1]![1]!.get(pluginPageContext)).toMatchObject({
      error: 'The page is too large',
    });
    expect(pulled).toBeLessThan(10);
  });

  it('takes a post as a page only from a browser’s navigation', async () => {
    const machine = await call('/plugins/punchout/partners', {
      method: 'POST',
      headers: { accept: '*/*' },
      body: 'x',
    });
    expect(machine.headers.get('content-type')).toBe(PLUGIN_VIEW_TYPE);
    expect(rendered).not.toHaveBeenCalled();
    await call('/plugins/punchout/partners', { method: 'POST', headers: page, body: 'x' });
    expect(rendered).toHaveBeenCalledOnce();
  });
});
