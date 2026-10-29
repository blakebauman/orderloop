import { describe, expect, it } from 'vitest';
import { bearerApiCall, crossOrigin, isLocalHost } from '../app/lib/origin';

const ORIGIN = 'https://orderloop.app';
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/carts`, { method, headers });

describe('crossOrigin', () => {
  it('lets reads through from anywhere', () => {
    expect(crossOrigin(req('GET', { origin: 'https://evil.example' }), ORIGIN)).toBe(false);
    expect(crossOrigin(req('HEAD', { 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe(false);
  });

  it('refuses writes from other origins, sibling subdomains included', () => {
    expect(crossOrigin(req('POST', { origin: ORIGIN }), ORIGIN)).toBe(false);
    expect(crossOrigin(req('POST', { origin: 'https://api.orderloop.app' }), ORIGIN)).toBe(true);
    expect(crossOrigin(req('DELETE', { origin: 'https://evil.example' }), ORIGIN)).toBe(true);
    expect(crossOrigin(req('POST', { origin: 'null' }), ORIGIN)).toBe(true);
    expect(crossOrigin(req('POST', { origin: 'http://orderloop.app' }), ORIGIN)).toBe(true);
  });

  it('checks the WebSocket handshake although it is a GET', () => {
    const ws = (origin: string) => req('GET', { upgrade: 'websocket', origin });
    expect(crossOrigin(ws(ORIGIN), ORIGIN)).toBe(false);
    expect(crossOrigin(ws('https://app.orderloop.app'), ORIGIN)).toBe(true);
  });

  it('falls back to Sec-Fetch-Site, and leaves non-browser clients alone', () => {
    expect(crossOrigin(req('POST', { 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(false);
    expect(crossOrigin(req('POST', { 'sec-fetch-site': 'same-site' }), ORIGIN)).toBe(true);
    expect(crossOrigin(req('POST', { 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe(true);
    expect(crossOrigin(req('POST'), ORIGIN)).toBe(false);
  });
});

describe('bearerApiCall', () => {
  const call = (path: string, auth?: string) => {
    const url = new URL(path, ORIGIN);
    const headers: Record<string, string> = { origin: 'https://evil.example', cookie: 's=1' };
    if (auth) headers.authorization = auth;
    return bearerApiCall(new Request(url, { method: 'POST', headers }), url);
  };

  it('exempts only a REST API call with a bearer token', () => {
    expect(call('/api/v1/orders', 'Bearer ol_live_x')).toBe(true);
    expect(call('/api/v1/orders')).toBe(false);
    // A page's action reads the cookie whatever else is sent, so a bearer header buys nothing.
    expect(call('/team', 'Bearer x')).toBe(false);
    expect(call('/orders/ord_1', 'bearer x')).toBe(false);
    expect(call('/api/v1/orders', 'Basic eDp4')).toBe(false);
  });
});

describe('isLocalHost', () => {
  it('is true only for local development hosts', () => {
    for (const u of [
      'http://localhost:5173/',
      'http://127.0.0.1/',
      'http://[::1]:8787/',
      'http://app.localhost/',
    ])
      expect(isLocalHost(new URL(u))).toBe(true);
    for (const u of [
      'https://orderloop.app/',
      'https://orderloop-web.example.workers.dev/',
      'http://localhost.evil.example/',
    ])
      expect(isLocalHost(new URL(u))).toBe(false);
  });
});
