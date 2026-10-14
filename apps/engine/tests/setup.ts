import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_SEED: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
await applyD1Migrations(testEnv.DB, testEnv.TEST_SEED);
