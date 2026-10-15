import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export * from './schema';
export { schema };

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from './audit';
export * from './flows';
export * from './match';
