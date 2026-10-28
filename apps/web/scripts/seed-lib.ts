/**
 * What the local seed scripts share: the dev server's own D1 and R2 through wrangler's platform
 * proxy, batched SQL inserts, a seeded random source, and the local dev sign-in the records seed
 * writes for the scripts that call the API. Local only: the proxy's config binds nothing remote.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MIN = 60_000;

/** Bytes per INSERT statement, under D1's 100 KB statement limit. */
const STATEMENT_BYTES = 90_000;
/** Statements per D1 batch (each batch is one transaction). */
const BATCH = 50;

export const WEB = new URL('..', import.meta.url).pathname;
const ROOT = join(WEB, '../..');

export function failWith(script: string) {
  return (message: string): never => {
    console.error(`${script}: ${message}`);
    process.exit(1);
  };
}

/**
 * The local D1 (and the DOCS bucket) the dev server uses (`apps/web/.wrangler/state`), through a
 * config that binds only those: nothing remote is bound, so nothing here can reach a deployed
 * workspace.
 */
export async function localEnv() {
  const wrangler = readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8');
  const id = wrangler.match(/"binding":\s*"DB",[^}]*?"database_id":\s*"([^"]+)"/s)?.[1];
  const bucket = wrangler.match(/"binding":\s*"DOCS",\s*"bucket_name":\s*"([^"]+)"/)?.[1];
  if (!id || !bucket) failWith('seed')('no DB or DOCS binding in apps/web/wrangler.jsonc');
  const config = join(mkdtempSync(join(tmpdir(), 'orderloop-seed-')), 'wrangler.json');
  writeFileSync(
    config,
    JSON.stringify({
      name: 'seed',
      compatibility_date: '2026-01-01',
      d1_databases: [{ binding: 'DB', database_name: 'orderloop', database_id: id }],
      r2_buckets: [{ binding: 'DOCS', bucket_name: bucket }],
    }),
  );
  return getPlatformProxy<{ DB: D1Database; DOCS: R2Bucket }>({
    configPath: config,
    persist: { path: join(WEB, '.wrangler/state/v3') },
  });
}

export async function run(db: D1Database, statements: string[]) {
  for (let i = 0; i < statements.length; i += BATCH)
    await db.batch(statements.slice(i, i + BATCH).map((s) => db.prepare(s)));
}

/** mulberry32: small, fast and the same everywhere for a seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
    /** A weighted choice from [value, weight] pairs. */
    weighted: <T>(pairs: readonly (readonly [T, number])[]): T => {
      let r = next() * pairs.reduce((s, [, w]) => s + w, 0);
      for (const [v, w] of pairs) {
        r -= w;
        if (r <= 0) return v;
      }
      return pairs.at(-1)![0];
    },
    /** Log-normal around `median`, for durations: most near it, a long slow tail. */
    around: (median: number, spread = 0.8) => {
      const u = Math.max(next(), 1e-9);
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      return Math.max(1, Math.round(median * Math.exp(z * spread)));
    },
  };
}
export type Rng = ReturnType<typeof rng>;

export const q = (v: unknown) =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replaceAll("'", "''")}'`;

export function inserts(
  table: string,
  cols: string[],
  rows: unknown[][],
  verb = 'INSERT',
): string[] {
  const head = `${verb} INTO ${table} (${cols.join(', ')}) VALUES\n`;
  const out: string[] = [];
  let batch: string[] = [];
  let size = head.length;
  for (const r of rows) {
    const row = `(${r.map(q).join(', ')})`;
    if (batch.length && size + row.length + 2 > STATEMENT_BYTES) {
      out.push(`${head}${batch.join(',\n')};`);
      batch = [];
      size = head.length;
    }
    batch.push(row);
    size += row.length + 2;
  }
  if (batch.length) out.push(`${head}${batch.join(',\n')};`);
  return out;
}

/**
 * The local dev admin's sign-in and API token, which `seed-records.ts` writes and the API seeds
 * read. Kept in `.secrets/` (gitignored); never a deployed workspace's.
 */
export const LOCAL_LOGIN = join(ROOT, '.secrets/local-dev-login.json');
export type LocalLogin = { email: string; password: string; token: string };

export function readLocalLogin(): LocalLogin | null {
  if (!existsSync(LOCAL_LOGIN)) return null;
  try {
    return JSON.parse(readFileSync(LOCAL_LOGIN, 'utf8')) as LocalLogin;
  } catch {
    return null;
  }
}
