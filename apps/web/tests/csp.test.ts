import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, parseEmbed, withSecurityHeaders } from '../app/lib/csp';

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
        formAction: ['javascript:alert(1)', 'https://ok.example/a b'],
      }),
    );
    expect(embed).toEqual({ frameAncestors: [], formAction: [] });
    expect(parseEmbed('not json')).toBeNull();
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
