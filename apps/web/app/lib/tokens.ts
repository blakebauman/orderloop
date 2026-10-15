/** API token lifetimes and states. Pure; the Team page and `auth.server.ts` use them. */

const DAY = 86_400_000;

/** The choices on the Team page, in days. Every token expires, within a year at most. */
export const TOKEN_LIFETIMES = {
  '30': '30 days',
  '90': '90 days',
  '365': '1 year',
} as const;

export type TokenLifetime = keyof typeof TOKEN_LIFETIMES;

export const DEFAULT_LIFETIME: TokenLifetime = '90';

/** A token is flagged on the Team page this long before it expires. */
export const EXPIRING_SOON = 14 * DAY;

export const isTokenLifetime = (v: unknown): v is TokenLifetime =>
  typeof v === 'string' && v in TOKEN_LIFETIMES;

/** When a token made now with this lifetime expires. */
export function expiresAtFor(lifetime: TokenLifetime, now: number): number {
  return now + Number(lifetime) * DAY;
}

export type TokenState = 'active' | 'expiring' | 'expired' | 'revoked';

export function tokenState(
  t: { revokedAt: number | null; expiresAt: number | null },
  now: number,
): TokenState {
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt === null) return 'active';
  if (t.expiresAt <= now) return 'expired';
  return t.expiresAt - now <= EXPIRING_SOON ? 'expiring' : 'active';
}
