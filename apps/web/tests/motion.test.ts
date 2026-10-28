import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EASE, MOTION } from '../app/lib/motion';

const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

describe('motion tokens', () => {
  it('match app.css for script-driven animation', () => {
    for (const [name, ms] of Object.entries(MOTION))
      expect(token(`motion-${name}`)).toBe(`${ms}ms`);
    for (const [name, curve] of Object.entries(EASE)) expect(token(`ease-${name}`)).toBe(curve);
  });
});
