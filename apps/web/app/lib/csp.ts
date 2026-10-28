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

/**
 * Carried from the sign-in and setup pages' `headers` when the deployment uses Turnstile
 * (`withTurnstilePolicy`); entry.server.tsx lets that page alone load Turnstile, and drops it.
 */
export const TURNSTILE_HEADER = 'x-orderloop-turnstile';

/** Where Turnstile's script and challenge frame come from. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Any https page may frame this one. Only for a refusal a buyer's page shows in its frame (a used
 * start link, a closed cart): it carries no data and nothing to click, and without it the buyer
 * sees a blocked frame instead of the reason.
 */
export const ANY_HTTPS_FRAMER = 'https:';

/**
 * `v` as a CSP source: an https URL's origin and path. CSP ignores the query, and matches paths
 * after percent-decoding them, so a path's `;` `,` and `'` (which the policy's grammar would split
 * on) are encoded rather than dropped: a return URL like `/punchout;jsessionid=…` must still be
 * one the form may post to. Null for anything else, or a host the grammar can't carry.
 */
function httpsSource(v: unknown, keepPath: boolean): string | null {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  // The URL parser accepts these in a host; a source can't hold them.
  if (/[^\x21-\x7e]|[;,']/.test(u.origin)) return null;
  if (!keepPath) return u.origin;
  return (
    u.origin + u.pathname.replace(/[;,']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  );
}

const sources = (vs: unknown, keepPath: boolean) => [
  ...new Set(
    (Array.isArray(vs) ? vs : []).flatMap((v) => {
      const s = httpsSource(v, keepPath);
      return s ? [s] : [];
    }),
  ),
];

/** An embed policy read back from `EMBED_HEADER`, keeping only https sources. */
export function parseEmbed(raw: string | null): EmbedPolicy | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<EmbedPolicy>;
    const anyFramer =
      Array.isArray(e.frameAncestors) && e.frameAncestors.includes(ANY_HTTPS_FRAMER);
    return {
      frameAncestors: anyFramer ? [ANY_HTTPS_FRAMER] : sources(e.frameAncestors, false),
      formAction: sources(e.formAction, true),
    };
  } catch {
    return null;
  }
}

/**
 * The Content-Security-Policy for an HTML page. Scripts run only from this origin or with the
 * response's nonce (the theme script and React Router's inline scripts); styles and fonts come
 * from this origin. Pages can't be framed, and forms post only here, unless `embed` (an external
 * cart's page) names the origins that may frame it and where its return form posts. A page with
 * `turnstile` (sign-in or setup, on a deployment that uses it) may also run Turnstile's script and
 * show its challenge frame.
 */
export function contentSecurityPolicy(
  nonce: string,
  embed?: EmbedPolicy | null,
  opts: { turnstile?: boolean } = {},
): string {
  const ancestors = embed?.frameAncestors.length ? embed.frameAncestors.join(' ') : "'none'";
  const actions = ["'self'", ...(embed?.formAction ?? [])].join(' ');
  const turnstile = opts.turnstile ? ` ${TURNSTILE_ORIGIN}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${turnstile}`,
    ...(opts.turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
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
