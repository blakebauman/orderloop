import { describe, expect, it } from 'vitest';
import { scrubCredentials } from '../src';

describe('scrubCredentials', () => {
  it('replaces the values it was given, longest first', () => {
    expect(
      scrubCredentials('carrier said: key abcd1234 and abcd1234XYZ', ['abcd1234', 'abcd1234XYZ']),
    ).toBe('carrier said: key [redacted] and [redacted]');
  });

  it('catches credentials by shape', () => {
    const cases: [string, string][] = [
      ['token sk_live_abcdefgh12345678 failed', 'token [redacted] failed'],
      ['use sk-ant-REDACTEDREDACTED0123', 'use [redacted]'],
      ['gh: ghp_abcdefghijklmnopqrstuvwxyz0123', 'gh: [redacted]'],
      ['aws AKIAABCDEFGHIJKLMNOP here', 'aws [redacted] here'],
      ['Authorization: Bearer abc.def-ghi_jkl', 'Authorization: Bearer [redacted]'],
      ['jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'jwt [redacted]'],
      ['GET https://user:hunter22@api.test/x', 'GET https://[redacted]@api.test/x'],
      ['{"api_key":"q1w2e3r4t5"}', '{"api_key":"[redacted]"}'],
      ['password=hunter2hunter2', 'password=[redacted]'],
      ['-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----', '[redacted]'],
    ];
    for (const [input, want] of cases) expect(scrubCredentials(input)).toBe(want);
  });

  it('masks long random runs but leaves ordinary text and ids', () => {
    expect(scrubCredentials('id Zq8vP2xK9mW4tR7yB3nL6cF1hJ5dS0gA')).toBe('id [redacted]');
    expect(scrubCredentials('order ord_northwind_2026_shipment_label done')).toBe(
      'order ord_northwind_2026_shipment_label done',
    );
    expect(scrubCredentials('Carrier refused: address line 2 too long')).toBe(
      'Carrier refused: address line 2 too long',
    );
  });
});
