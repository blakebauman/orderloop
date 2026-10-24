import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export * from './schema';
export { schema };

const build = (d1: D1Database) => drizzle(d1, { schema });
export type Db = ReturnType<typeof build>;

/** One Drizzle instance per D1 binding, so a request that asks again reuses it. */
const instances = new WeakMap<D1Database, Db>();

export function createDb(d1: D1Database): Db {
  let db = instances.get(d1);
  if (!db) {
    db = build(d1);
    instances.set(d1, db);
  }
  return db;
}
export * from './audit';
export * from './flows';
export * from './match';
