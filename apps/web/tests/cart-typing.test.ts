import { CART_TYPING_EVERY_MS, CART_TYPING_MS, type CartTyping } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import {
  NO_TYPISTS,
  nextTypingEnd,
  typingAt,
  typingDue,
  typingLabel,
  typingSeen,
} from '../app/lib/cart-typing';

const now = 1_000_000;
const notice = (memberId: string, name: string, until = now + CART_TYPING_MS): CartTyping => ({
  type: 'cart_typing',
  memberId,
  name,
  until,
});

describe('cart typing', () => {
  it('shows each typist until their notice ends, and never the page’s own person', () => {
    let t = typingSeen(NO_TYPISTS, notice('usr_ann', 'Ann', now + 4_000), 'usr_me', now);
    t = typingSeen(t, notice('usr_me', 'Me'), 'usr_me', now);
    expect([...t.keys()]).toEqual(['usr_ann']);
    expect(t.get('usr_ann')!.until).toBe(now + 4_000);
    expect(typingAt(t, now + 3_999)).toBe(t);
    expect(typingAt(t, now + 4_000).size).toBe(0);
  });

  it('keeps a notice within its length of arriving, whatever the agent’s clock says', () => {
    // The agent's clock ahead of this browser's: no longer than a notice lasts.
    const ahead = typingSeen(NO_TYPISTS, notice('a', 'A', now + 60_000), null, now);
    expect(ahead.get('a')!.until).toBe(now + CART_TYPING_MS);
    // Behind it: a notice that would have ended already still shows for its length.
    const behind = typingSeen(NO_TYPISTS, notice('a', 'A', now - 3_000), null, now);
    expect(behind.get('a')!.until).toBe(now + CART_TYPING_MS);
  });

  it('ends a typist’s notice when they send their message or leave, and refreshes it', () => {
    let t = typingSeen(NO_TYPISTS, notice('a', 'Ann', now + 3_000), null, now);
    t = typingSeen(t, notice('a', 'Ann', now + 2_000 + CART_TYPING_MS), null, now + 2_000);
    expect(t.get('a')!.until).toBe(now + 2_000 + CART_TYPING_MS);
    expect(typingSeen(t, notice('a', 'Ann', 0), null, now + 2_500).size).toBe(0);
    // A stop for someone not showing changes nothing.
    expect([...typingSeen(t, notice('b', 'Ben', 0), null, now).keys()]).toEqual(['a']);
  });

  it('says who is typing, by name for one or two', () => {
    const one = typingSeen(NO_TYPISTS, notice('a', 'Ann'), null, now);
    const two = typingSeen(one, notice('b', 'Ben'), null, now);
    const three = typingSeen(two, notice('c', 'Cy'), null, now);
    expect(typingLabel(NO_TYPISTS)).toBe('');
    expect(typingLabel(one)).toBe('Ann is typing…');
    expect(typingLabel(two)).toBe('Ann and Ben are typing…');
    expect(typingLabel(three)).toBe('Several people are typing…');
    // The same people refreshing say the same thing, so a live region doesn't announce it again.
    expect(typingLabel(typingSeen(two, notice('a', 'Ann'), null, now + 2_000))).toBe(
      typingLabel(two),
    );
  });

  it('looks again when the soonest notice ends', () => {
    expect(nextTypingEnd(NO_TYPISTS)).toBeNull();
    const t = typingSeen(
      typingSeen(NO_TYPISTS, notice('a', 'A', now + 4_000), null, now),
      notice('b', 'B', now + 2_000),
      null,
      now,
    );
    expect(nextTypingEnd(t)).toBe(now + 2_000);
  });

  it('lets the composer say so at most once every two seconds', () => {
    expect(typingDue(null, now)).toBe(true);
    expect(typingDue(now, now + CART_TYPING_EVERY_MS - 1)).toBe(false);
    expect(typingDue(now, now + CART_TYPING_EVERY_MS)).toBe(true);
  });
});
