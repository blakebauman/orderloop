import { describe, expect, it, vi } from 'vitest';
import {
  generatePassword,
  hashPassword,
  isEmail,
  needsRehash,
  newApiToken,
  normalizeEmail,
  passwordProblem,
  pepperId,
  pepperMismatch,
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

  it('peppers a hash when the deployment has a pepper, and still reads the ones made before', async () => {
    const pepper = 'p'.repeat(64);
    const stored = await hashPassword('correct horse battery', pepper);
    expect(stored).toMatch(/^pbkdf2p:[\w-]{8}:100000:[\w-]{22}:[\w-]{43}$/);
    expect(stored.split(':')[1]).toBe(await pepperId(pepper));
    expect(await verifyPassword('correct horse battery', stored, pepper)).toBe(true);
    // Without the pepper, or with another one, a copy of the hash is useless.
    expect(await verifyPassword('correct horse battery', stored)).toBe(false);
    expect(await verifyPassword('correct horse battery', stored, 'q'.repeat(64))).toBe(false);
    // One made before the pepper verifies, and is due to be stored again.
    const old = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', old, pepper)).toBe(true);
    expect(needsRehash(old, pepper)).toBe(true);
    expect(needsRehash(stored, pepper)).toBe(false);
    expect(needsRehash(old, undefined)).toBe(false);
  });

  it('names the pepper a hash was made with, so a lost or changed one is told apart', async () => {
    const pepper = 'p'.repeat(64);
    const stored = await hashPassword('correct horse battery', pepper);
    expect(await pepperId(pepper)).not.toBe(await pepperId('q'.repeat(64)));
    expect(await pepperMismatch(stored, pepper)).toBe(false);
    expect(await pepperMismatch(stored, 'q'.repeat(64))).toBe(true);
    expect(await pepperMismatch(stored, undefined)).toBe(true);
    // An unpeppered hash, or one this module didn't make, is never a mismatch.
    expect(await pepperMismatch(await hashPassword('x'), pepper)).toBe(false);
    expect(await pepperMismatch('bcrypt:10:x:y', pepper)).toBe(false);
    // A peppered hash whose id was tampered with doesn't verify even with the right pepper.
    const [, , ...rest] = stored.split(':');
    const forged = ['pbkdf2p', 'AAAAAAAA', ...rest].join(':');
    expect(await verifyPassword('correct horse battery', forged, pepper)).toBe(false);
  });

  it('pays for the derivation on a pepper mismatch, as for an unknown email', async () => {
    const stored = await hashPassword('correct horse battery', 'p'.repeat(64));
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      expect(await verifyPassword('correct horse battery', stored, 'q'.repeat(64))).toBe(false);
      expect(await verifyPassword('correct horse battery', stored)).toBe(false);
      expect(derive).toHaveBeenCalledTimes(2);
    } finally {
      derive.mockRestore();
    }
  });

  it('rejects malformed or out-of-range stored hashes', async () => {
    for (const bad of [
      '',
      'bcrypt:10:x:y',
      'pbkdf2:0:abc:def',
      'pbkdf2:99999999:abc:def',
      'pbkdf2p:100000:abc:def',
      'pbkdf2:id:100000:abc:def',
    ])
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
