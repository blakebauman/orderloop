/**
 * Credentials kept out of what a plugin can write back: its failure messages, summaries and logs
 * reach the order timeline, webhooks and Workers Logs. The values the engine injected for it are
 * replaced exactly (`known`); anything that still looks like a credential is caught by shape
 * (keys with a known prefix, private keys, JWTs, credentials in URLs, `secret=…` pairs) and, last,
 * by entropy (a long run of random-looking characters).
 */

const MASK = '[redacted]';

const PATTERNS: RegExp[] = [
  // PEM private keys, whole.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Keys with a well-known prefix: OpenAI/Anthropic/Stripe-style, GitHub, Slack, AWS access keys.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Bearer and Basic credentials.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** `password=…`, `api_key: …`, `"token":"…"`: the value after a name that says it's secret. */
const NAMED =
  /\b((?:[A-Za-z_-]*(?:secret|token|password|passwd|api[_-]?key|apikey)[A-Za-z_-]*|[A-Za-z_-]*auth(?:orization|[_-]?token|[_-]?key)?)\b)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\[redacted\])([^\s"'&,;]{6,})/gi;

/** Credentials in a URL: `https://user:pass@host`. */
const URL_AUTH = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Bits of entropy per character above which a 24+ character run is taken for a secret. */
const ENTROPY_BITS = 4.2;

function entropy(s: string) {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** `text` with `known` values and anything shaped like a credential replaced by `[redacted]`. */
export function scrubCredentials(text: string, known: readonly string[] = []): string {
  let out = text;
  // Longest first, so a value that contains another is replaced whole.
  for (const k of [...known].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length))
    out = out.split(k).join(MASK);
  for (const re of PATTERNS)
    out = out.replace(re, (_m, scheme) =>
      typeof scheme === 'string' && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${MASK}` : MASK,
    );
  out = out.replace(NAMED, (_m, name, sep) => `${name}${sep}${MASK}`);
  out = out.replace(URL_AUTH, (_m, scheme) => `${scheme}${MASK}@`);
  return out.replace(/[A-Za-z0-9+/_=-]{24,}/g, (run) =>
    run.includes(MASK) || entropy(run) < ENTROPY_BITS ? run : MASK,
  );
}
