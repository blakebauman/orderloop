import { describe, expect, it } from 'vitest';
import { freshKeys } from '../app/lib/use-arrivals';

describe('freshKeys', () => {
  const now = 10_000;

  it('treats nothing as new before the first render is known', () => {
    expect(freshKeys(['a', 'b'], null, now, 5)).toEqual(new Set());
  });

  it('marks only keys the list has not seen', () => {
    const known = new Map([['a', 0]]);
    expect(freshKeys(['a', 'b'], known, now, 5)).toEqual(new Set(['b']));
  });

  it('keeps a key new while it is still animating, then lets it settle', () => {
    const known = new Map([['b', now - 100]]);
    expect(freshKeys(['b'], known, now, 5)).toEqual(new Set(['b']));
    expect(freshKeys(['b'], known, now + 1000, 5)).toEqual(new Set());
  });

  it('animates nothing when a burst lands, so a refresh never plays as a backlog', () => {
    const known = new Map<string, number>();
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(freshKeys(keys, known, now, 5)).toEqual(new Set());
    expect(freshKeys(keys.slice(0, 5), known, now, 5).size).toBe(5);
  });
});
