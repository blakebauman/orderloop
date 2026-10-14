/**
 * How many failed attempts each key may have in a window before attempts are refused. Pure, so
 * the rules are unit tested; `auth.server.ts` reads and writes the counts in D1 `auth_failures`.
 */

export const WINDOW_MS = 15 * 60_000;

/** Failures allowed per window, by key kind. */
export const LIMITS = {
  /** One person from one place: the tight limit. */
  'email-ip': 5,
  /** One place trying many accounts. */
  ip: 30,
  /** Many places trying one account; high, so an attacker can't easily lock a person out. */
  email: 50,
  /** Guesses at the shared APP_PASSWORD as an API bearer token, per place. */
  'api-ip': 20,
  /** Wrong two-factor codes for one person, after a correct password. */
  'two-factor': 5,
  /** Wrong current passwords from someone already signed in (Account page re-checks). */
  reauth: 5,
} as const;

export type ThrottleKind = keyof typeof LIMITS;

export type FailureRow = { key: string; count: number; windowStart: number };

export const throttleKey = (kind: ThrottleKind, value: string) => `${kind}:${value}`;

/** The keys a sign-in attempt counts against. A blank email is the shared workspace password. */
export function signInKeys(email: string, ip: string): string[] {
  const who = email.trim().toLowerCase() || '(workspace password)';
  return [
    throttleKey('email-ip', `${who}|${ip}`),
    throttleKey('ip', ip),
    throttleKey('email', who),
  ];
}

/**
 * Milliseconds until the attempt may go ahead, or 0. A key is over its limit when its window is
 * still open and it has reached the limit; the longest wait wins.
 */
export function blockedFor(rows: FailureRow[], now: number): number {
  let wait = 0;
  for (const r of rows) {
    const kind = r.key.slice(0, r.key.indexOf(':')) as ThrottleKind;
    const limit = LIMITS[kind];
    const ends = r.windowStart + WINDOW_MS;
    if (limit !== undefined && now < ends && r.count >= limit) wait = Math.max(wait, ends - now);
  }
  return wait;
}

/** "Try again in 12 minutes" for a wait in milliseconds. */
export function retryText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
