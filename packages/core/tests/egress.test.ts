import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EgressRefused,
  egressProblem,
  isInternalName,
  readCappedJson,
  readCappedText,
  safeFetch,
} from '../src/egress';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the egress policy', () => {
  it('allows a public https host, and nothing that only resolves inside a network', () => {
    expect(egressProblem('https://hooks.example.com/orderloop')).toBeNull();
    for (const url of [
      'http://hooks.example.com/',
      'ftp://hooks.example.com/',
      'https://user:pw@hooks.example.com/',
      'https://localhost/',
      'https://app.localhost/',
      'https://db.internal/',
      'https://printer.local/',
      'https://intranet/',
      'https://router.lan/',
      'https://box.home.arpa/',
      'https://metadata.google.internal/',
      'https://10.0.0.1.nip.io/',
      'https://anything.sslip.io/',
      'not a url',
    ])
      expect(egressProblem(url), url).not.toBeNull();
  });

  it('refuses every IP literal, naming a private one as such', () => {
    expect(egressProblem('https://10.0.0.1/')).toMatch(/private/);
    expect(egressProblem('https://169.254.169.254/latest/meta-data')).toMatch(/private/);
    expect(egressProblem('https://[::ffff:a00:1]/')).toMatch(/private/);
    expect(egressProblem('https://[64:ff9b::a00:1]/')).toMatch(/private/);
    // Public services are reached by name.
    expect(egressProblem('https://1.1.1.1/')).toMatch(/IP address/);
    expect(egressProblem('https://[2606:4700::1111]/')).toMatch(/IP address/);
  });

  it('lets a local receiver through only where loopback is allowed', () => {
    expect(egressProblem('http://localhost:8787/hook')).not.toBeNull();
    expect(egressProblem('http://localhost:8787/hook', { loopback: true })).toBeNull();
    expect(egressProblem('http://127.0.0.1/hook', { loopback: true })).toBeNull();
    expect(egressProblem('http://[::1]/hook', { loopback: true })).toBeNull();
    // Loopback is the machine itself, not the private network around it.
    expect(egressProblem('http://10.0.0.1/hook', { loopback: true })).not.toBeNull();
    expect(egressProblem('http://u:p@localhost/hook', { loopback: true })).not.toBeNull();
  });

  it('refuses a host ending in a dot, however it is written', () => {
    for (const url of [
      'https://localhost./',
      'https://localhost%2e/',
      'https://localhost\u3002/',
      'https://db.internal./',
      'https://metadata.google.internal./',
      'https://10.0.0.1.nip.io./',
      'https://intranet./',
      'https://hooks.example.com./',
    ])
      expect(egressProblem(url), url).not.toBeNull();
  });

  it('refuses the other ways an IPv4 address can be written', () => {
    for (const url of [
      'https://2130706433/',
      'https://0x7f.1/',
      'https://0177.0.0.1/',
      'https://0/',
    ])
      expect(egressProblem(url), url).toMatch(/private/);
  });

  it('names a single label or a wildcard-DNS service as internal', () => {
    expect(isInternalName('intranet')).toBe(true);
    expect(isInternalName('intranet.')).toBe(true);
    expect(isInternalName('x.nip.io')).toBe(true);
    expect(isInternalName('x.nip.io.')).toBe(true);
    expect(isInternalName('hooks.example.com')).toBe(false);
  });
});

describe('safeFetch', () => {
  const answers = (...responses: Response[]) => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return responses.shift() ?? new Response('none');
      }),
    );
    return seen;
  };
  const moved = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  it('refuses a URL the policy refuses, before any request', async () => {
    const seen = answers();
    await expect(safeFetch('https://10.0.0.1/')).rejects.toBeInstanceOf(EgressRefused);
    expect(seen).toEqual([]);
  });

  it('refuses a redirect, and never follows one itself', async () => {
    const seen = answers(moved('https://elsewhere.example.com/'));
    await expect(
      safeFetch('https://hooks.example.com/', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
    ).rejects.toThrow(/redirect from hooks\.example\.com \(HTTP 302\)/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.redirect).toBe('manual');
  });

  it('follows a few redirects for a GET without credentials, checking each', async () => {
    const seen = answers(
      moved('https://cdn.example.com/a.png'),
      new Response('png', { headers: { 'content-type': 'image/png' } }),
    );
    const res = await safeFetch('https://shop.example.com/a.png', { redirects: 3 });
    expect(await res.text()).toBe('png');
    expect(seen.map((s) => s.url)).toEqual([
      'https://shop.example.com/a.png',
      'https://cdn.example.com/a.png',
    ]);
    // A redirect to a refused place stops there.
    answers(moved('https://169.254.169.254/'));
    await expect(safeFetch('https://shop.example.com/a.png', { redirects: 3 })).rejects.toThrow(
      /private/,
    );
    // And no redirects at all for a credentialed or non-GET request.
    await expect(
      safeFetch('https://shop.example.com/', { redirects: 1, method: 'POST' }),
    ).rejects.toBeInstanceOf(EgressRefused);
    await expect(
      safeFetch('https://shop.example.com/', {
        redirects: 1,
        headers: { authorization: 'Basic x' },
      }),
    ).rejects.toBeInstanceOf(EgressRefused);
  });

  it('refuses a redirect for a GET unless it allows some', async () => {
    answers(moved('https://cdn.example.com/'));
    await expect(safeFetch('https://shop.example.com/')).rejects.toThrow(/HTTP 302/);
  });

  it('resolves a relative Location, and checks where it lands', async () => {
    const seen = answers(moved('/b.png'), moved('//cdn.example.com/c.png'), new Response('ok'));
    await safeFetch('https://shop.example.com/a/a.png', { redirects: 3 });
    expect(seen.map((s) => s.url)).toEqual([
      'https://shop.example.com/a/a.png',
      'https://shop.example.com/b.png',
      'https://cdn.example.com/c.png',
    ]);
    answers(moved('http://shop.example.com/a.png'));
    await expect(safeFetch('https://shop.example.com/', { redirects: 3 })).rejects.toThrow(
      /https only/,
    );
    answers(moved('https://localhost./'));
    await expect(safeFetch('https://shop.example.com/', { redirects: 3 })).rejects.toBeInstanceOf(
      EgressRefused,
    );
  });

  it('follows no redirect for any credential header', async () => {
    for (const header of ['cookie', 'proxy-authorization', 'x-api-key'])
      await expect(
        safeFetch('https://shop.example.com/', { redirects: 1, headers: { [header]: 'x' } }),
        header,
      ).rejects.toBeInstanceOf(EgressRefused);
  });

  it('gives up after its timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
          ),
      ),
    );
    await expect(safeFetch('https://slow.example.com/', { timeoutMs: 20 })).rejects.toThrow(
      /timed out|timeout/i,
    );
  });

  it('stops after the redirects it was allowed', async () => {
    answers(moved('https://a.example.com/'), moved('https://b.example.com/'));
    await expect(safeFetch('https://s.example.com/', { redirects: 1 })).rejects.toThrow(
      /redirect from a\.example\.com/,
    );
  });
});

describe('reading a capped body', () => {
  it('reads up to the cap, and refuses past it, declared or streamed', async () => {
    expect(await readCappedJson(new Response('{"ok":true}'), 100)).toEqual({ ok: true });
    await expect(readCappedText(new Response('x'.repeat(101)), 100)).rejects.toBeInstanceOf(
      EgressRefused,
    );
    const declared = new Response('small', { headers: { 'content-length': '999999' } });
    await expect(readCappedText(declared, 100)).rejects.toBeInstanceOf(EgressRefused);
    await expect(readCappedJson(new Response('not json'), 100)).rejects.toThrow();
  });
});
