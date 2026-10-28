import { describe, expect, it } from 'vitest';
import { promotionState } from '../app/lib/promotions';

const DAY = 86_400_000;
const now = Date.parse('2026-10-27T12:00:00Z');

describe('promotionState', () => {
  it('is active or paused as set while the code is in date', () => {
    expect(promotionState({ status: 'active', validTo: null }, now)).toBe('active');
    expect(promotionState({ status: 'paused', validTo: now + DAY }, now)).toBe('paused');
  });

  it('is ended once the end date has passed, whether paused or not', () => {
    // SPRING15: paused, and its last day was weeks ago. "Paused" would suggest Resume brings it back.
    const ended = Date.parse('2026-10-15T23:59:59Z');
    expect(promotionState({ status: 'paused', validTo: ended }, now)).toBe('ended');
    expect(promotionState({ status: 'active', validTo: ended }, now)).toBe('ended');
  });

  it('ends at the instant the discount step stops applying it', () => {
    expect(promotionState({ status: 'active', validTo: now }, now)).toBe('ended');
    expect(promotionState({ status: 'active', validTo: now + 1 }, now)).toBe('active');
  });
});
