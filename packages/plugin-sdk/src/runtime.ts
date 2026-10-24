/**
 * What a plugin reads from its environment, the same whichever way it runs:
 *
 * - `secret(env, name)`: a plain Worker secret (a `worker` plugin on a shared account), a Secrets
 *   Store binding (a `worker` plugin on its own account) or, in the sandbox, the `SECRETS`
 *   capability, which answers only for secrets the manifest marks `expose` (injected ones never
 *   reach the plugin at all).
 * - `pluginDb(env)`: the plugin's own D1 database (`DB`) as a Worker, or in the sandbox its
 *   `STORAGE` capability (a SQLite Durable Object the engine keeps for it) behind the same
 *   `prepare().bind().first/all/run` and `batch` calls.
 *
 * Read secrets and the database through these, never `env.X` directly, and a plugin runs
 * unchanged as a Worker or sandboxed. See docs/plugins.md, "Runtimes".
 */

/** The sandbox's secrets capability. `has` answers for any declared secret, `get` only exposed ones. */
export type SecretsCapability = {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | null>;
};

/** The sandbox's storage capability: SQL against the plugin's own SQLite database. */
export type StorageCapability = {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; changes: number }>;
  batch(
    statements: { sql: string; params: unknown[] }[],
  ): Promise<{ rows: Record<string, unknown>[]; changes: number }[]>;
};

type Env = Record<string, unknown>;

const isStoreBinding = (v: unknown): v is { get(): Promise<string> } =>
  !!v && typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function';

/** The sandbox puts its capabilities under these names; no secret or binding may take them. */
const capability = <T>(env: Env, name: 'SECRETS' | 'STORAGE') =>
  (env.__ORDERLOOP_SANDBOX === true ? env[name] : undefined) as T | undefined;

/** A secret's value, wherever this plugin's runtime keeps it; undefined when it isn't set. */
export async function secret(env: object, name: string): Promise<string | undefined> {
  const e = env as Env;
  const sandbox = capability<SecretsCapability>(e, 'SECRETS');
  if (sandbox) return (await sandbox.get(name)) ?? undefined;
  const v = e[name];
  if (typeof v === 'string') return v || undefined;
  if (isStoreBinding(v)) {
    try {
      return (await v.get()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether a secret is set, without reading it where the runtime can avoid that. */
export async function hasSecret(env: object, name: string): Promise<boolean> {
  const sandbox = capability<SecretsCapability>(env as Env, 'SECRETS');
  if (sandbox) return sandbox.has(name);
  return (await secret(env, name)) !== undefined;
}

type Row = Record<string, unknown>;

/** The part of `D1PreparedStatement` plugins use. */
export type Statement = {
  bind(...params: unknown[]): Statement;
  first<T = Row>(column?: string): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[]; success: true; meta: { changes: number } }>;
  run(): Promise<{ success: true; meta: { changes: number } }>;
};

/** The part of `D1Database` plugins use. */
export type PluginDatabase = {
  prepare(sql: string): Statement;
  batch(
    statements: Statement[],
  ): Promise<{ results: Row[]; success: true; meta: { changes: number } }[]>;
};

const QUERY = Symbol('query');

function statement(storage: StorageCapability, sql: string, params: unknown[] = []): Statement {
  const s: Statement & { [QUERY]: { sql: string; params: unknown[] } } = {
    [QUERY]: { sql, params },
    bind: (...p) => statement(storage, sql, p),
    async first<T>(column?: string) {
      const row = (await storage.query(sql, params)).rows[0];
      if (!row) return null;
      return (column ? row[column] : row) as T;
    },
    async all<T>() {
      const r = await storage.query(sql, params);
      return { results: r.rows as T[], success: true as const, meta: { changes: r.changes } };
    },
    async run() {
      const r = await storage.query(sql, params);
      return { success: true as const, meta: { changes: r.changes } };
    },
  };
  return s;
}

/** The plugin's database: its D1 as a Worker, its SQLite storage in the sandbox. */
export function pluginDb(env: object): PluginDatabase {
  const e = env as Env;
  const storage = capability<StorageCapability>(e, 'STORAGE');
  if (!storage) {
    if (!e.DB) throw new Error('This plugin has no database: add a D1 binding named DB');
    return e.DB as PluginDatabase;
  }
  return {
    prepare: (sql) => statement(storage, sql),
    async batch(statements) {
      const out = await storage.batch(
        statements.map(
          (s) => (s as unknown as { [QUERY]: { sql: string; params: unknown[] } })[QUERY],
        ),
      );
      return out.map((r) => ({
        results: r.rows,
        success: true as const,
        meta: { changes: r.changes },
      }));
    },
  };
}
