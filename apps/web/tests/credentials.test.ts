import { describe, expect, it } from 'vitest';
import {
  generatePassword,
  hashPassword,
  isEmail,
  newApiToken,
  normalizeEmail,
  passwordProblem,
  safeEqual,
  sha256Hex,
  verifyPassword,
} from '../app/lib/credentials';

describe('credentials', () => {
  it('hashes passwords with PBKDF2 and verifies only the right one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^pbkdf2:100000:[\w-]{22}:[\w-]{43}$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    // A second hash of the same password has a different salt.
    expect(await hashPassword('correct horse battery')).not.toBe(stored);
  });

  it('rejects malformed or out-of-range stored hashes', async () => {
    for (const bad of ['', 'bcrypt:10:x:y', 'pbkdf2:0:abc:def', 'pbkdf2:99999999:abc:def'])
      expect(await verifyPassword('x', bad)).toBe(false);
  });

  it('makes API tokens that are stored and shown only in part', async () => {
    const t = await newApiToken();
    expect(t.token).toMatch(/^ol_live_[\w-]{32}$/);
    expect(t.prefix).toBe(t.token.slice(0, 12));
    expect(t.hash).toBe(await sha256Hex(t.token));
    expect(t.hash).not.toContain(t.token);
    expect((await newApiToken()).token).not.toBe(t.token);
  });

  it('generates long one-time passwords and normalises emails', () => {
    expect(generatePassword()).toHaveLength(20);
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(isEmail('ada@example.com')).toBe(true);
    expect(isEmail('ada@example')).toBe(false);
  });

  it('compares strings without short-circuiting on content', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('passwordProblem', () => {
  it('requires length and rejects common passwords and the email', () => {
    expect(passwordProblem('short', 'ada@example.com')).toBe('Use at least 10 characters.');
    expect(passwordProblem('password123', 'ada@example.com')).toBe('That password is too common.');
    expect(passwordProblem('lovelace-2026!', 'lovelace@example.com')).toBe(
      'Don’t include your email address.',
    );
    expect(passwordProblem('a long and unusual phrase', 'ada@example.com')).toBeNull();
  });
});
