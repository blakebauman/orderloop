import { createContext } from 'react';

/** The per-response nonce for inline scripts, set by `entry.server.tsx`; absent in the browser. */
export const NonceContext = createContext<string | undefined>(undefined);

/** A fresh nonce for one HTML response. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * What a page an external cart's buyer sees adds to its policy: the origins that may frame it (the
 * buyer's procurement system) and where its return form may post. Both come from the cart, which
 * the plugin opened with https values the engine checked.
 */
export type EmbedPolicy = { frameAncestors: string[]; formAction: string[] };

/** Carried from a route's `headers` to entry.server.tsx, which folds it into the CSP and drops it. */
export const EMBED_HEADER = 'x-orderloop-embed';

const https = (v: unknown): v is string => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !/[\s;,']/.test(String(v));
  } catch {
    return false;
  }
};

/** An embed policy read back from `EMBED_HEADER`, keeping only https sources. */
export function parseEmbed(raw: string | null): EmbedPolicy | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<EmbedPolicy>;
    return {
      frameAncestors: [
        ...new Set((e.frameAncestors ?? []).filter(https).map((o) => new URL(o).origin)),
      ],
      formAction: (e.formAction ?? []).filter(https),
    };
  } catch {
    return null;
  }
}

/**
 * The Content-Security-Policy for an HTML page. Scripts run only from this origin or with the
 * response's nonce (the theme script and React Router's inline scripts); styles and fonts come
 * from this origin. Pages can't be framed, and forms post only here, unless `embed` (an external
 * cart's page) names the origins that may frame it and where its return form posts.
 */
export function contentSecurityPolicy(nonce: string, embed?: EmbedPolicy | null): string {
  const ancestors = embed?.frameAncestors.length ? embed.frameAncestors.join(' ') : "'none'";
  const actions = ["'self'", ...(embed?.formAction ?? [])].join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${actions}`,
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

/**
 * Headers every response from the web Worker carries. HSTS only over HTTPS, so local development
 * on http://localhost isn't pinned.
 */
export function withSecurityHeaders(res: Response, url: URL): Response {
  // A WebSocket upgrade's response can't be rebuilt, and has no body to protect.
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  const set = (k: string, v: string) => {
    if (!out.headers.has(k)) out.headers.set(k, v);
  };
  set('x-content-type-options', 'nosniff');
  set('referrer-policy', 'strict-origin-when-cross-origin');
  // A page that allows framers says so in its CSP (frame-ancestors), which X-Frame-Options can't.
  if (!/frame-ancestors (?!'none')/.test(out.headers.get('content-security-policy') ?? ''))
    set('x-frame-options', 'DENY');
  set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (url.protocol === 'https:')
    set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return out;
}
