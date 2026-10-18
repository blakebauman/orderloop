import { readFileSync } from 'node:fs';
import { DEV_DATA_KEY, DEV_PRINCIPAL_KEY } from '@orderloop/core';
import { describe, expect, it } from 'vitest';

describe('local dev keys', () => {
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

  it('signs the principal header with the same key in vite.config.ts (the engine) and core (the web app)', () => {
    expect(config).toContain(`const DEV_PRINCIPAL_KEY = '${DEV_PRINCIPAL_KEY}';`);
  });

  it('encrypts secrets with the same key in vite.config.ts (the engine) and core (the web app)', () => {
    expect(config).toContain(`const DEV_DATA_KEY = '${DEV_DATA_KEY}';`);
  });
});
