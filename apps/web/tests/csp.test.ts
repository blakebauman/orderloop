import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANY_HTTPS_FRAMER,
  contentSecurityPolicy,
  documentNonce,
  NonceContext,
  parseEmbed,
  useNonce,
  withSecurityHeaders,
} from '../app/lib/csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `));

describe('page CSP', () => {
  it('forbids framing and posts only here by default', () => {
    const csp = contentSecurityPolicy('n');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('lets an external cart be framed by its origins and post its return to its URL', () => {
    const embed = parseEmbed(
      JSON.stringify({
        frameAncestors: ['https://buyer.example', 'https://buyer.example/path?x=1'],
        formAction: ['https://buyer.example/punchout/return'],
      }),
    );
    const csp = contentSecurityPolicy('n', embed);
    expect(directive(csp, 'frame-ancestors')).toBe('frame-ancestors https://buyer.example');
    expect(directive(csp, 'form-action')).toBe(
      "form-action 'self' https://buyer.example/punchout/return",
    );
  });

  it('keeps only https sources, and nothing that could add a directive', () => {
    const embed = parseEmbed(
      JSON.stringify({
        frameAncestors: ['http://buyer.example', "https://x.example; script-src 'unsafe-inline'"],
        formAction: [
          'javascript:alert(1)',
          "https://x.example; script-src 'unsafe-inline'",
          'https://user:pw@buyer.example/return',
          // The URL parser lets these into a host; a source can't carry them.
          'https://a;b.example/return',
          'https://a,b.example/return',
          "https://a'b.example/return",
        ],
      }),
    );
    expect(embed).toEqual({ frameAncestors: [], formAction: [] });
    expect(parseEmbed('not json')).toBeNull();
  });

  it('keeps a return URL whose path or query holds the policy’s separators', () => {
    const embed = parseEmbed(
      JSON.stringify({
        frameAncestors: [],
        formAction: [
          'https://buyer.example/punchout;jsessionid=ABC',
          'https://buyer.example/ret?ids=1,2;x=3',
          "https://buyer.example/a,b/it's here",
        ],
      }),
    );
    // CSP decodes a path before matching and ignores the query, so these still admit the post.
    expect(embed?.formAction).toEqual([
      'https://buyer.example/punchout%3Bjsessionid=ABC',
      'https://buyer.example/ret',
      'https://buyer.example/a%2Cb/it%27s%20here',
    ]);
    const csp = contentSecurityPolicy('n', embed);
    expect(csp.split('; ')).toHaveLength(10);
    expect(directive(csp, 'form-action')?.split(' ')).toHaveLength(5);
  });

  it('lets any https page frame a refusal, and nothing else', () => {
    const embed = parseEmbed(JSON.stringify({ frameAncestors: [ANY_HTTPS_FRAMER] }));
    expect(embed).toEqual({ frameAncestors: ['https:'], formAction: [] });
    expect(directive(contentSecurityPolicy('n', embed), 'frame-ancestors')).toBe(
      'frame-ancestors https:',
    );
    expect(parseEmbed(JSON.stringify({ frameAncestors: 'https:' }))?.frameAncestors).toEqual([]);
  });

  it('sends X-Frame-Options only when the page can’t be framed', () => {
    const url = new URL('https://app.example/');
    const framed = withSecurityHeaders(
      new Response('', {
        headers: { 'content-security-policy': 'frame-ancestors https://buyer.example' },
      }),
      url,
    );
    expect(framed.headers.get('x-frame-options')).toBeNull();
    const closed = withSecurityHeaders(
      new Response('', { headers: { 'content-security-policy': "frame-ancestors 'none'" } }),
      url,
    );
    expect(closed.headers.get('x-frame-options')).toBe('DENY');
    expect(withSecurityHeaders(new Response(''), url).headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('the nonce in the browser', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A page whose theme script was served with `nonce`, its attribute emptied as under a CSP header. */
  const page = (nonce: string | null) => ({
    querySelector: (sel: string) =>
      sel === 'script[nonce]' && nonce !== null ? { nonce, getAttribute: () => '' } : null,
  });
  const Script = () => createElement('script', { nonce: useNonce() });

  it('renders the same nonce the server did, read from the property, so hydration matches', () => {
    const server = renderToStaticMarkup(
      createElement(NonceContext.Provider, { value: 'r4nd0m' }, createElement(Script)),
    );
    vi.stubGlobal('document', page('r4nd0m'));
    expect(renderToStaticMarkup(createElement(Script))).toBe(server);
    expect(server).toContain('nonce="r4nd0m"');
  });

  it('has none where the page carries none, and none on the server without a context', () => {
    expect(documentNonce(page(null))).toBeUndefined();
    expect(documentNonce(page(''))).toBeUndefined();
    expect(documentNonce(undefined)).toBeUndefined();
  });
});
