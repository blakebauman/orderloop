import { readFileSync } from 'node:fs';
import { DEV_PRINCIPAL_KEY } from '@orderloop/core';
import { describe, expect, it } from 'vitest';

describe('local dev principal key', () => {
  it('is the same in vite.config.ts (the engine checks with it) and core (the web app signs)', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toContain(`const DEV_PRINCIPAL_KEY = '${DEV_PRINCIPAL_KEY}';`);
  });
});
