import { describe, expect, it } from 'vitest';
import { blockedFor, LIMITS, retryText, signInKeys, WINDOW_MS } from '../app/lib/throttle';

const now = 1_800_000_000_000;

describe('throttle', () => {
  it('counts a sign-in against the person-and-place, the place and the person', () => {
    expect(signInKeys(' Ada@Example.com ', '203.0.113.7')).toEqual([
      'email-ip:ada@example.com|203.0.113.7',
      'ip:203.0.113.7',
      'email:ada@example.com',
    ]);
    expect(signInKeys('', '203.0.113.7')[2]).toBe('email:(workspace password)');
  });

  it('blocks a key that reached its limit inside the window, until the window ends', () => {
    const key = 'email-ip:ada@example.com|203.0.113.7';
    const started = now - 5 * 60_000;
    expect(blockedFor([{ key, count: LIMITS['email-ip'] - 1, windowStart: started }], now)).toBe(0);
    expect(blockedFor([{ key, count: LIMITS['email-ip'], windowStart: started }], now)).toBe(
      10 * 60_000,
    );
    // An old window no longer counts.
    expect(blockedFor([{ key, count: 99, windowStart: now - WINDOW_MS - 1 }], now)).toBe(0);
  });

  it('uses each kind’s own limit and the longest wait', () => {
    const rows = [
      { key: 'ip:203.0.113.7', count: LIMITS.ip - 1, windowStart: now - 60_000 },
      { key: 'email:ada@example.com', count: LIMITS.email, windowStart: now - 2 * 60_000 },
      { key: 'api-ip:203.0.113.7', count: LIMITS['api-ip'], windowStart: now - 14 * 60_000 },
    ];
    expect(blockedFor(rows, now)).toBe(13 * 60_000);
    expect(blockedFor([{ key: 'unknown:x', count: 1e6, windowStart: now }], now)).toBe(0);
    expect(
      blockedFor(
        [{ key: 'two-factor:usr_ann', count: LIMITS['two-factor'], windowStart: now }],
        now,
      ),
    ).toBe(WINDOW_MS);
  });

  it('rounds the wait up to whole minutes', () => {
    expect(retryText(1)).toBe('Try again in 1 minute.');
    expect(retryText(12 * 60_000 + 1)).toBe('Try again in 13 minutes.');
  });
});
