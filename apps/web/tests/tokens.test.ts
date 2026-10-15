import { describe, expect, it } from 'vitest';
import { expiresAtFor, isTokenLifetime, tokenState } from '../app/lib/tokens';

const DAY = 86_400_000;
const now = 1_800_000_000_000;

describe('token lifetimes', () => {
  it('turns a lifetime into an expiry time', () => {
    expect(expiresAtFor('30', now)).toBe(now + 30 * DAY);
    expect(expiresAtFor('365', now)).toBe(now + 365 * DAY);
    expect(isTokenLifetime('90')).toBe(true);
    expect(isTokenLifetime('7')).toBe(false);
    // Every token expires: there is no lifetime without an end, and none longer than a year.
    expect(isTokenLifetime('never')).toBe(false);
    expect(isTokenLifetime('730')).toBe(false);
  });

  it('says whether a token is active, expiring soon, expired or revoked', () => {
    const t = (expiresAt: number | null, revokedAt: number | null = null) => ({
      expiresAt,
      revokedAt,
    });
    expect(tokenState(t(null), now)).toBe('active');
    expect(tokenState(t(now + 30 * DAY), now)).toBe('active');
    expect(tokenState(t(now + 14 * DAY), now)).toBe('expiring');
    expect(tokenState(t(now), now)).toBe('expired');
    expect(tokenState(t(now - 1), now)).toBe('expired');
    // Revoked wins over everything.
    expect(tokenState(t(now - DAY, now - 2 * DAY), now)).toBe('revoked');
  });
});
