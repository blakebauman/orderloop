import { defineConfig } from 'vitest/config';

// In Node: `cloudflare:workers` is mocked in the tests, and the contract suite needs no runtime.
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
