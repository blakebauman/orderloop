/**
 * Where the engine reaches a plugin, whichever way the deployment runs it (`PluginRuntime`):
 *
 * - `worker`: its own Worker, bound as `PLUGIN_<ID>` (scripts/fleet.ts renders the binding).
 * - `sandboxed`: a Dynamic Worker this engine loads (Worker Loader) from the bundle CI built,
 *   verified and pinned in `PLUGIN_BUNDLES` (`{ "<id>": "<sha>" }`, the bundle in `DOCS` at
 *   `plugins/<id>/<sha>.json`). It gets no bindings: only the capabilities below, scoped to it by
 *   `props`. Its outbound requests go through `PluginEgress`, its logs through `PluginTail`, and
 *   each call is capped in CPU and subrequests (`PLUGIN_LIMIT_CAPS`).
 *
 * Secrets for a plugin come from the deployment's Secrets Store when it has one (own Cloudflare
 * account: `PLUGIN_SECRET_<ID>__<NAME>` bindings) or from `PLUGIN_SECRETS` (shared account: JSON
 * the deploy writes from `PLUGIN_<ID>_<NAME>` in the GitHub environment). See docs/plugins.md,
 * "Runtimes" and "Secrets".
 */

import { DurableObject, WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers';
import {
  egressAllows,
  PLUGIN_LIMIT_CAPS,
  PLUGIN_SECRET_NAME_RE,
  type PluginManifest,
  type PluginRpc,
  type PluginRuntime,
  pluginBinding,
  pluginKey,
  scrubCredentials,
} from '@orderloop/core';
import { createDb, pluginErrors } from '@orderloop/db';
import { and, desc, eq, notInArray } from 'drizzle-orm';

export type PluginStub = Fetcher & { [K in keyof PluginRpc]: PluginRpc[K] };

/** What a call is for: inside an order's step, or a page or event delivery. */
export type CallKind = keyof typeof PLUGIN_LIMIT_CAPS;

type Vars = Record<string, unknown>;

/** The compatibility date sandboxed plugins run on (the engine's). */
const SANDBOX_COMPAT_DATE = '2026-10-01';

/** Redirects the egress gateway follows for a plugin, each checked again. */
const MAX_REDIRECTS = 5;

/** The bundles this deployment pins, by plugin id. */
function bundles(env: Env): Record<string, string> {
  const raw = (env as unknown as Vars).PLUGIN_BUNDLES;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(v).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && /^[0-9a-f]{64}$/.test(e[1]),
      ),
    );
  } catch {
    console.error('PLUGIN_BUNDLES is not JSON; no sandboxed plugin is loaded');
    return {};
  }
}

/** Every plugin this deployment installs: its `PLUGIN_*` service bindings and pinned bundles. */
export function installedPlugins(env: Env): { id: string; runtime: PluginRuntime }[] {
  const out = new Map<string, PluginRuntime>();
  // A plugin's binding never holds "__" (ids have no "--"), so a Secrets Store binding for a
  // plugin's secret (`storeBinding`) is never taken for a plugin.
  for (const [k, v] of Object.entries(env as unknown as Vars))
    if (k.startsWith('PLUGIN_') && !k.includes('__') && typeof (v as Fetcher)?.fetch === 'function')
      out.set(k.slice('PLUGIN_'.length).toLowerCase().replaceAll('_', '-'), 'worker');
  for (const id of Object.keys(bundles(env))) if (!out.has(id)) out.set(id, 'sandboxed');
  return [...out].map(([id, runtime]) => ({ id, runtime }));
}

/**
 * The last manifest each plugin answered with (kept by `pluginStatuses`). The capabilities read it
 * to know what a plugin declared (egress hosts, secrets) without calling into the plugin again.
 */
export const knownManifests = new Map<string, PluginManifest>();

/** The per-call limits for a sandboxed plugin: its manifest's, within the caps for `kind`. */
export function limitsFor(kind: CallKind, manifest?: Pick<PluginManifest, 'limits'>) {
  const cap = PLUGIN_LIMIT_CAPS[kind];
  return {
    cpuMs: Math.min(manifest?.limits.cpuMs ?? cap.cpuMs, cap.cpuMs),
    subRequests: Math.min(manifest?.limits.subRequests ?? cap.subRequests, cap.subRequests),
  };
}

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

type Bundle = { code: string; migrations: { name: string; sql: string }[] };

/**
 * Bundles this isolate has read and checked against their pins, so the loader never runs one
 * that wasn't (and its callback never fails: a bad bundle is refused before it is loaded).
 */
const verified = new Map<string, Bundle>();

async function verifiedBundle(env: Env, id: string, sha: string): Promise<Bundle> {
  const key = `${id}@${sha}`;
  const hit = verified.get(key);
  if (hit) return hit;
  const bundle = await loadBundle(env, id, sha);
  verified.set(key, bundle);
  return bundle;
}

function devBundle(env: Env, id: string): string | undefined {
  const raw = (env as unknown as Vars).PLUGIN_DEV_BUNDLES;
  if (typeof raw !== 'string') return undefined;
  try {
    const body = (JSON.parse(raw) as Record<string, unknown>)[id];
    return typeof body === 'string' ? body : undefined;
  } catch {
    return undefined;
  }
}

/** A pinned bundle from `DOCS`, refused unless it hashes to its pin. */
async function loadBundle(env: Env, id: string, sha: string): Promise<Bundle> {
  const obj = await env.DOCS.get(`plugins/${id}/${sha}.json`);
  // Local dev hands the engine its bundles directly (apps/web/vite.config.ts); checked the same.
  const body = obj ? await obj.text() : devBundle(env, id);
  if (body === undefined)
    throw new Error(`Plugin “${id}”: bundle ${sha.slice(0, 12)} is not published`);
  if ((await sha256(body)) !== sha)
    throw new Error(`Plugin “${id}”: bundle ${sha.slice(0, 12)} doesn't match its pin`);
  return JSON.parse(body) as Bundle;
}

type Exports = Record<string, (opts: { props: Vars }) => unknown>;
const capabilities = () => workerExports as unknown as Exports;

/**
 * The plugin to call: its binding, or its sandbox with the limits for `kind`; null when it isn't
 * installed. `manifest` (when the caller has it) narrows the limits to what the plugin asked for.
 */
export async function pluginStub(
  env: Env,
  id: string,
  kind: CallKind = 'call',
  manifest?: Pick<PluginManifest, 'limits'>,
): Promise<PluginStub | null> {
  const bound = (env as unknown as Vars)[pluginBinding(id)];
  if (typeof (bound as Fetcher | undefined)?.fetch === 'function') return bound as PluginStub;
  const sha = bundles(env)[id];
  if (!sha) return null;
  const bundle = await verifiedBundle(env, id, sha);
  const keys = await sandboxKeys(env, id);
  const caps = capabilities();
  const worker = env.LOADER.get(`plugin:${id}@${sha}`, async () => {
    return {
      compatibilityDate: SANDBOX_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'index.js',
      modules: { 'index.js': bundle.code },
      env: {
        __ORDERLOOP_SANDBOX: true,
        ...keys,
        SECRETS: caps.PluginSecrets!({ props: { id } }),
        STORAGE: caps.PluginDb!({ props: { id, sha } }),
      },
      globalOutbound: caps.PluginEgress!({ props: { id } }),
      tails: [caps.PluginTail!({ props: { id } })],
    } as unknown as WorkerLoaderWorkerCode;
  });
  return worker.getEntrypoint(undefined, {
    limits: limitsFor(kind, manifest ?? knownManifests.get(id)),
  }) as unknown as PluginStub;
}

/** The page-signing keys a sandboxed plugin verifies with, as a Worker plugin's secrets hold them. */
async function sandboxKeys(env: Env, id: string) {
  const e = env as unknown as Vars;
  const current = typeof e.PRINCIPAL_KEY === 'string' ? e.PRINCIPAL_KEY : '';
  const previous = typeof e.PRINCIPAL_KEY_PREVIOUS === 'string' ? e.PRINCIPAL_KEY_PREVIOUS : '';
  return {
    ...(current ? { PLUGIN_KEY: await pluginKey(current, id) } : {}),
    ...(previous ? { PLUGIN_KEY_PREVIOUS: await pluginKey(previous, id) } : {}),
  };
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** The engine's Secrets Store binding for a plugin's secret (own-account deployments). */
export const storeBinding = (id: string, name: string) =>
  `PLUGIN_SECRET_${id.toUpperCase().replaceAll('-', '_')}__${name}`;

/**
 * A plugin's secret, read now (so a rotated Secrets Store value applies on the next call): from
 * the deployment's Secrets Store when it has a binding for it, else from `PLUGIN_SECRETS`.
 */
export async function resolveSecret(env: Env, id: string, name: string) {
  if (!PLUGIN_SECRET_NAME_RE.test(name)) return undefined;
  const e = env as unknown as Vars;
  const bound = e[storeBinding(id, name)] as { get?: () => Promise<string> } | undefined;
  if (typeof bound?.get === 'function') {
    try {
      return (await bound.get()) || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const all = JSON.parse(typeof e.PLUGIN_SECRETS === 'string' ? e.PLUGIN_SECRETS : '{}');
    const v = (all as Record<string, Record<string, unknown>>)[id]?.[name];
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    console.error('PLUGIN_SECRETS is not JSON; no plugin secret is set');
    return undefined;
  }
}

/** Every value of the plugin's declared secrets that is set, for scrubbing what it writes back. */
export async function knownSecretValues(env: Env, id: string): Promise<string[]> {
  const m = knownManifests.get(id);
  if (!m) return [];
  const values = await Promise.all(m.secrets.map((s) => resolveSecret(env, id, s.name)));
  return values.filter((v): v is string => !!v);
}

/** A sandboxed plugin's `SECRETS`: whether any declared secret is set, and exposed ones' values. */
export class PluginSecrets extends WorkerEntrypoint<Env, { id: string }> {
  async has(name: string): Promise<boolean> {
    return (await resolveSecret(this.env, this.ctx.props.id, name)) !== undefined;
  }

  async get(name: string): Promise<string | null> {
    const declared = knownManifests.get(this.ctx.props.id)?.secrets.find((s) => s.name === name);
    if (!declared?.expose) return null;
    return (await resolveSecret(this.env, this.ctx.props.id, name)) ?? null;
  }
}

// ── Egress ───────────────────────────────────────────────────────────────────

/** Host names that only resolve inside a network, and wildcard-DNS services that point anywhere. */
const BLOCKED_HOST =
  /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|metadata\.google\.internal|nip\.io|sslip\.io|xip\.io|localtest\.me)$/i;

/** An IP literal in a private, loopback, link-local, CGNAT, multicast or reserved range. */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (!h.includes(':')) return false;
  if (h === '::' || h === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) is checked as the IPv4 address.
  const mapped = /^::ffff:(.+)$/.exec(h)?.[1];
  if (mapped) {
    if (mapped.includes('.')) return isPrivateAddress(mapped);
    const [hi, lo] = mapped.split(':').map((x) => Number.parseInt(x, 16));
    if (hi !== undefined && lo !== undefined)
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(h);
}

/** Why a sandboxed plugin may not reach `url`, or null when it may. */
export function egressRefusal(manifest: Pick<PluginManifest, 'egress'>, url: URL): string | null {
  if (url.protocol !== 'https:') return 'only https is allowed';
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateAddress(host) || BLOCKED_HOST.test(host)) return `${host} is not a public host`;
  if (!egressAllows(manifest.egress, host)) return `${host} is not in the plugin's egress`;
  return null;
}

/**
 * Every outbound request a sandboxed plugin makes (`globalOutbound`): refused unless it is https
 * to a public host in the manifest's `egress`, with the plugin's `inject` secrets added for their
 * host. Redirects are followed here, at most `MAX_REDIRECTS`, each checked again, and an injected
 * credential never follows a redirect to another host.
 */
export class PluginEgress extends WorkerEntrypoint<Env, { id: string }> {
  override async fetch(request: Request): Promise<Response> {
    const id = this.ctx.props.id;
    const manifest = knownManifests.get(id);
    if (!manifest) return refuse(id, request.url, 'the plugin is not loaded');
    const body =
      request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
    let url = new URL(request.url);
    let method = request.method;
    let payload: ArrayBuffer | null = body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const why = egressRefusal(manifest, url);
      if (why) return refuse(id, url.toString(), why);
      const headers = new Headers(request.headers);
      for (const s of manifest.secrets) {
        if (!s.inject) continue;
        headers.delete(s.inject.header);
        if (!egressAllows([s.inject.host], url.hostname)) continue;
        const value = await resolveSecret(this.env, id, s.name);
        if (value) headers.set(s.inject.header, s.inject.format.replace('{}', value));
      }
      const res = await fetch(url, { method, headers, body: payload, redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return res;
      url = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        payload = null;
      }
    }
    return refuse(id, url.toString(), `more than ${MAX_REDIRECTS} redirects`);
  }
}

function refuse(id: string, url: string, why: string) {
  console.warn(JSON.stringify({ plugin: id, egress: 'refused', url: url.slice(0, 200), why }));
  return new Response(`Refused by OrderLoop: ${why}`, { status: 403 });
}

// ── Storage ──────────────────────────────────────────────────────────────────

type Statement = { sql: string; params: unknown[] };
type Result = { rows: Record<string, unknown>[]; changes: number };

/**
 * A sandboxed plugin's database: one SQLite Durable Object per plugin id, with the migrations of
 * the bundle it runs applied once, forward only (`_orderloop_migrations` records them by name).
 */
export class PluginStorage extends DurableObject<Env> {
  private migrated = new Set<string>();

  private async migrate(id: string, sha: string) {
    if (this.migrated.has(sha)) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _orderloop_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const done = new Set(
      sql
        .exec<{ name: string }>('SELECT name FROM _orderloop_migrations')
        .toArray()
        .map((r) => r.name),
    );
    const { migrations } = await loadBundle(this.env, id, sha);
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const statement of m.sql.split(/;\s*(?:\r?\n|$)/).filter((x) => x.trim()))
          sql.exec(statement);
        sql.exec(
          'INSERT INTO _orderloop_migrations (name, applied_at) VALUES (?, ?)',
          m.name,
          Date.now(),
        );
      });
    }
    this.migrated.add(sha);
  }

  private run({ sql, params }: Statement): Result {
    if (/\b_orderloop_migrations\b/i.test(sql)) throw new Error('That table is the engine’s');
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const rows = cursor.toArray() as Record<string, unknown>[];
    return { rows, changes: cursor.rowsWritten };
  }

  async query(id: string, sha: string, statement: Statement): Promise<Result> {
    await this.migrate(id, sha);
    return this.run(statement);
  }

  async batch(id: string, sha: string, statements: Statement[]): Promise<Result[]> {
    await this.migrate(id, sha);
    return this.ctx.storage.transactionSync(() => statements.map((s) => this.run(s)));
  }
}

/** A sandboxed plugin's `STORAGE`: SQL against its own `PluginStorage`, and nothing else. */
export class PluginDb extends WorkerEntrypoint<Env, { id: string; sha: string }> {
  private storage() {
    return this.env.PLUGIN_STORAGE.getByName(this.ctx.props.id);
  }

  async query(sql: string, params: unknown[] = []) {
    return this.storage().query(this.ctx.props.id, this.ctx.props.sha, { sql, params });
  }

  async batch(statements: Statement[]) {
    return this.storage().batch(this.ctx.props.id, this.ctx.props.sha, statements);
  }
}

// ── Logs ─────────────────────────────────────────────────────────────────────

/** How many of a plugin's latest exceptions `plugin_errors` keeps. */
const ERRORS_KEPT = 100;

/**
 * A sandboxed plugin's Tail Worker: its logs go to the engine's (Workers Logs), tagged with the
 * plugin and scrubbed of its secrets, and its exceptions to `plugin_errors` for the Plugins page.
 */
export class PluginTail extends WorkerEntrypoint<Env, { id: string }> {
  override async tail(events: TraceItem[]) {
    const id = this.ctx.props.id;
    const known = await knownSecretValues(this.env, id);
    const clean = (s: unknown) => scrubCredentials(String(s), known).slice(0, 2000);
    const db = createDb(this.env.DB);
    for (const e of events) {
      for (const log of e.logs)
        console.log(
          JSON.stringify({
            plugin: id,
            level: log.level,
            message: clean(JSON.stringify(log.message)),
          }),
        );
      for (const x of e.exceptions) {
        const message = clean(`${x.name}: ${x.message}`);
        console.error(JSON.stringify({ plugin: id, exception: message }));
        await db.insert(pluginErrors).values({
          id: crypto.randomUUID(),
          pluginId: id,
          message,
          at: x.timestamp || Date.now(),
        });
      }
    }
    // Only the latest are kept.
    const keep = db
      .select({ id: pluginErrors.id })
      .from(pluginErrors)
      .where(eq(pluginErrors.pluginId, id))
      .orderBy(desc(pluginErrors.at))
      .limit(ERRORS_KEPT);
    await db
      .delete(pluginErrors)
      .where(and(eq(pluginErrors.pluginId, id), notInArray(pluginErrors.id, keep)));
  }
}
