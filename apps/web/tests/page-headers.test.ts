import { createElement } from 'react';
import { createRequestHandler, type ServerBuild } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as entry from '../app/entry.server';
import { EMBED_HEADER, TURNSTILE_HEADER, withSecurityHeaders } from '../app/lib/csp';

/**
 * React Router with the app's own entry.server.tsx and one route whose `headers` asks for
 * Turnstile and an embed policy, as sign-in and an external cart's page do: what a page, a HEAD
 * and a `.data` request answer, once `withSecurityHeaders` (as workers/app.ts applies it) has run.
 */
const route = {
  id: 'root',
  path: '',
  module: {
    default: () => createElement('p', null, 'Sign in'),
    loader: () => ({ ok: true }),
    headers: () => ({
      [TURNSTILE_HEADER]: '1',
      [EMBED_HEADER]: JSON.stringify({ frameAncestors: ['https://buyer.example'] }),
    }),
  },
};
const build = {
  entry: { module: entry },
  routes: { root: route },
  assets: {
    entry: { module: '/entry.client.js', imports: [] },
    routes: {
      root: {
        id: 'root',
        path: '',
        module: '/root.js',
        hasLoader: true,
        hasAction: false,
        hasClientAction: false,
        hasClientLoader: false,
        hasClientMiddleware: false,
        hasErrorBoundary: false,
        imports: [],
        css: [],
      },
    },
    url: '/manifest.js',
    version: '1',
  },
  publicPath: '/',
  assetsBuildDirectory: 'build/client',
  future: {},
  ssr: true,
  isSpaMode: false,
  prerender: [],
  routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
} as unknown as ServerBuild;
const handler = createRequestHandler(build, 'production');

const answer = async (path: string, method = 'GET') => {
  const url = `https://acme.orderloop.app${path}`;
  return withSecurityHeaders(await handler(new Request(url, { method })), new URL(url));
};

afterEach(() => vi.unstubAllEnvs());

describe("a route's notes to entry.server", () => {
  it('fold into the page’s policy, which then admits Turnstile and the embed’s framers', async () => {
    vi.stubEnv('DEV', false);
    const res = await answer('/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain(' https://challenges.cloudflare.com;');
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain('frame-ancestors https://buyer.example');
  });

  it('never reach the client, on a page, a HEAD or a .data answer', async () => {
    // React Router hands a `.data` answer the route's headers without entry.server.
    const raw = await handler(new Request('https://acme.orderloop.app/_.data'));
    expect(raw.headers.get(TURNSTILE_HEADER)).toBe('1');
    for (const res of [await answer('/'), await answer('/', 'HEAD'), await answer('/_.data')]) {
      expect(res.headers.has(TURNSTILE_HEADER)).toBe(false);
      expect(res.headers.has(EMBED_HEADER)).toBe(false);
    }
  });

  it('are dropped by the HEAD answer itself, before workers/app.ts sees it', async () => {
    const res = await handler(new Request('https://acme.orderloop.app/', { method: 'HEAD' }));
    expect(res.headers.has(TURNSTILE_HEADER)).toBe(false);
    expect(res.headers.has(EMBED_HEADER)).toBe(false);
  });
});
