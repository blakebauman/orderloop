import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  SecretUnreadable,
  sealedWithCurrent,
} from '../src/encryption';

const OLD = 'old-data-key';
const NEW = 'new-data-key';

describe('secrets at rest', () => {
  it('encrypts under the current key and reads it back', async () => {
    const stored = await encryptSecret([NEW], 'JBSWY3DPEHPK3PXP', 'users.totp_secret:u1');
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await decryptSecret([NEW], stored, 'users.totp_secret:u1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV each time', async () => {
    const a = await encryptSecret([NEW], 'same', 'c');
    const b = await encryptSecret([NEW], 'same', 'c');
    expect(a).not.toBe(b);
  });

  it('refuses a value moved to another row', async () => {
    const stored = await encryptSecret([NEW], 'whsec_1', 'webhook_subscriptions.secret:a');
    await expect(
      decryptSecret([NEW], stored, 'webhook_subscriptions.secret:b'),
    ).rejects.toBeInstanceOf(SecretUnreadable);
  });

  it('refuses an altered value', async () => {
    const stored = await encryptSecret([NEW], 'whsec_1', 'c');
    const parts = stored.split('.');
    const ct = parts[3]!;
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(decryptSecret([NEW], parts.join('.'), 'c')).rejects.toBeInstanceOf(
      SecretUnreadable,
    );
    await expect(decryptSecret([NEW], `${stored}.x`, 'c')).rejects.toBeInstanceOf(SecretUnreadable);
  });

  it('reads values under the previous key during a rotation, and not after', async () => {
    const stored = await encryptSecret([OLD], 'creds', 'c');
    expect(await decryptSecret([NEW, OLD], stored, 'c')).toBe('creds');
    expect(await sealedWithCurrent([NEW, OLD], stored)).toBe(false);
    await expect(decryptSecret([NEW], stored, 'c')).rejects.toBeInstanceOf(SecretUnreadable);
    const resealed = await encryptSecret([NEW, OLD], 'creds', 'c');
    expect(await sealedWithCurrent([NEW, OLD], resealed)).toBe(true);
  });

  it('passes through a value stored before encryption', async () => {
    expect(await decryptSecret([NEW], 'whsec_plain', 'c')).toBe('whsec_plain');
    expect(await sealedWithCurrent([NEW], 'whsec_plain')).toBe(false);
  });

  it('needs a key to encrypt', async () => {
    await expect(encryptSecret([undefined, OLD], 'x', 'c')).rejects.toThrow(/DATA_KEY/);
  });
});
