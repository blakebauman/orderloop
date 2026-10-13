import { defineConfig } from 'vitest/config';

// Core is plain TypeScript with no runtime globals beyond the standard library, so it runs in Node.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
