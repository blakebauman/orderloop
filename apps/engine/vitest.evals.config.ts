import { defineConfig } from 'vitest/config';

// The AI evals (evals/): Node, not workerd, since they call the models over the REST API with the
// real prompt code. Not part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
});
