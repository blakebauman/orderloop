/**
 * Who is writing in a cart's chat (`components/cart-view.tsx`), from the `CartTyping` notices the
 * cart's agent sends the others while someone writes. Each shows until its `until`, kept within
 * `CART_TYPING_MS` of when it arrived, since the agent's clock and this browser's can differ. A
 * notice with `until` 0 (they sent it, or left) ends theirs; the page's own person never shows.
 */

import { CART_TYPING_EVERY_MS, CART_TYPING_MS, type CartTyping } from '@orderloop/core';

/** Member id to who they are and when their notice ends. */
export type Typists = ReadonlyMap<string, { name: string; until: number }>;

export const NO_TYPISTS: Typists = new Map();

/** The typists once `t` has arrived at `now`, as seen by `me`. */
export function typingSeen(
  typists: Typists,
  t: CartTyping,
  me: string | null,
  now: number,
): Typists {
  if (t.memberId === me) return typists;
  const next = new Map(typists);
  if (t.until <= 0) next.delete(t.memberId);
  else {
    const latest = now + CART_TYPING_MS;
    next.set(t.memberId, {
      name: t.name,
      until: t.until > now && t.until < latest ? t.until : latest,
    });
  }
  return next;
}

/** Only the notices still showing at `now` (the same map when none ended). */
export function typingAt(typists: Typists, now: number): Typists {
  const live = [...typists].filter(([, v]) => v.until > now);
  return live.length === typists.size ? typists : new Map(live);
}

/** When the next notice ends, to look again then; null when none show. */
export const nextTypingEnd = (typists: Typists): number | null =>
  typists.size ? Math.min(...[...typists.values()].map((v) => v.until)) : null;

/** What the chat says under its messages, or '' when no one is writing. */
export function typingLabel(typists: Typists): string {
  const names = [...typists.values()].map((v) => v.name);
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

/** Whether the composer may tell the cart again: at most once every `CART_TYPING_EVERY_MS`. */
export const typingDue = (lastSent: number | null, now: number) =>
  lastSent === null || now - lastSent >= CART_TYPING_EVERY_MS;
