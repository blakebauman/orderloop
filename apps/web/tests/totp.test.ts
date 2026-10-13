import { describe, expect, it } from 'vitest';
import {
  base32,
  fromBase32,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from '../app/lib/totp';

// RFC 6238 appendix B, SHA-1: the secret is the ASCII "12345678901234567890". Its codes are eight
// digits; six-digit codes are their last six.
const RFC_SECRET = base32(new TextEncoder().encode('12345678901234567890'));
const RFC: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('base32', () => {
  it('round-trips and matches RFC 4648', () => {
    expect(base32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
    expect(new TextDecoder().decode(fromBase32('mzxw 6ytb oi'.replace(/ /g, ''))!)).toBe('foobar');
    expect(fromBase32('not base32!')).toBeNull();
    expect(fromBase32(newTotpSecret())?.length).toBe(20);
  });
});

describe('totp', () => {
  it('matches the RFC 6238 test vectors', async () => {
    const key = fromBase32(RFC_SECRET)!;
    for (const [seconds, code] of RFC)
      expect(await totpCode(key, totpStep(seconds * 1000))).toBe(code);
  });

  it('accepts one step of clock drift either way, and no more', async () => {
    const now = 1111111111_000;
    const step = totpStep(now);
    const key = fromBase32(RFC_SECRET)!;
    for (const d of [-1, 0, 1])
      expect(await verifyTotp(RFC_SECRET, await totpCode(key, step + d), now)).toBe(step + d);
    expect(await verifyTotp(RFC_SECRET, await totpCode(key, step - 2), now)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, await totpCode(key, step + 2), now)).toBeNull();
  });

  it('refuses a step already used, so a code works once', async () => {
    const now = 1111111111_000;
    const step = totpStep(now);
    const code = await totpCode(fromBase32(RFC_SECRET)!, step);
    expect(await verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(await verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
  });

  it('takes spaces and dashes in a typed code, and refuses anything else', async () => {
    const now = 59_000;
    expect(await verifyTotp(RFC_SECRET, '287 082', now)).toBe(1);
    expect(await verifyTotp(RFC_SECRET, '287-082', now)).toBe(1);
    expect(await verifyTotp(RFC_SECRET, '28708', now)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
    expect(await verifyTotp('!!', '287082', now)).toBeNull();
  });

  it('builds the otpauth URI apps scan', () => {
    expect(otpauthUri('ABCD', 'ann@example.com')).toBe(
      'otpauth://totp/OrderLoop%3Aann%40example.com?secret=ABCD&issuer=OrderLoop&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('makes ten distinct, readable codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it('ignores case, spaces and the dash when hashing a typed code', async () => {
    const h = await hashRecoveryCode('k7mqp-3xw9d');
    expect(await hashRecoveryCode('K7MQP 3XW9D')).toBe(h);
    expect(await hashRecoveryCode('k7mqp3xw9d')).toBe(h);
    expect(await hashRecoveryCode('k7mqp-3xw9e')).not.toBe(h);
  });
});
