/**
 * The fleet: one OrderLoop deployment per customer, each listed in deployments/<id>.jsonc.
 *
 *   node scripts/fleet.ts render <id>             write apps/{engine,web}/wrangler.<id>.json
 *   node scripts/fleet.ts matrix                  print the deployments of each ring for CI
 *   node scripts/fleet.ts secrets <engine|web> <out>  write this app's secrets from the environment
 *   node scripts/fleet.ts status                  deep health of every deployment
 *   node scripts/fleet.ts names <id>              resource names, as shell variables (provisioning)
 *   node scripts/fleet.ts set-d1 <id> <uuid>      record the D1 database id in the registry
 *   node scripts/fleet.ts demos                   the provisioned demo deployments, for the nightly reset
 *
 * A rendered config is the app's wrangler.jsonc with the deployment's names, ids and domain put
 * in, written next to it so its relative paths still resolve. See docs/operations.md.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from 'jsonc-parser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RINGS = ['staging', 'internal', 'canary', 'general'] as const;
/** Ids a customer can't have: their `<id>.orderloop.app` would read as part of OrderLoop. */
const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blog',
  'cdn',
  'console',
  'dashboard',
  'dev',
  'docs',
  'help',
  'internal',
  'login',
  'mail',
  'mcp',
  'preview',
  'prod',
  'production',
  'sandbox',
  'staging',
  'status',
  'support',
  'test',
  'www',
]);
type Ring = (typeof RINGS)[number];

/** Each app's secrets, read from the deploy job's environment (a GitHub environment's secrets). */
const SECRETS = {
  web: ['SETUP_TOKEN', 'SHOPIFY_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET'],
  engine: ['INTAKE_ALLOWLIST', 'SHIPPING_CARRIER_AUTH', 'STRIPE_SECRET_KEY'],
} as const;

export type Deployment = {
  id: string;
  ring: Ring;
  /** Unique per deployment: keeps each one's rate-limit counters apart. */
  slot: number;
  /** Defaults to `<id>.orderloop.app`. */
  domain: string;
  /** Appended to every resource name. Defaults to `-<id>`; orderloop.app's own is `""`. */
  suffix: string;
  /** The GitHub environment holding this deployment's secrets. Defaults to `deploy-<id>`. */
  environment: string;
  /** Set by scripts/provision.sh; required to render or deploy. */
  d1Id?: string;
  /** Data location for D1 and R2 (`eu`), set when they're created. */
  jurisdiction?: 'eu' | 'fedramp';
  /** Skipped by CI: stays on what it runs now. */
  hold: boolean;
  /** Deploys the docs site after it (the orderloop deployment only). */
  docs: boolean;
  /**
   * A public demo: the demo data is loaded on each deploy and nightly, visitors sign in with one
   * click, models are mocked and waits run 1440× faster. Never on a customer's deployment.
   */
  demo: boolean;
  /** Requests a minute per caller, where this customer needs other than the base budgets. */
  limits?: Partial<Record<LimitKey, number>>;
  /** Days audit events are kept before they're archived to R2 and deleted (at least 90). */
  auditRetentionDays?: number;
  /** Days after an order finishes that its buyer's personal data is erased (at least 30). */
  personalDataRetentionDays?: number;
  /** Days the R2 archive keeps audit events past the database's retention; unset keeps them. */
  auditArchiveDays?: number;
  /** `send` lets workflow AI nodes see buyers' personal data; the default, `redact`, doesn't. */
  aiPersonalData: 'redact' | 'send';
  /** Whether the AI Gateway keeps request logs (prompts and responses). Default true. */
  aiGatewayLogs: boolean;
};

/** The registry's `limits` keys, and the web Worker's rate-limit binding each one sets. */
const LIMITS = { api: 'API_LIMIT', agents: 'AGENT_LIMIT', webhooks: 'WEBHOOK_LIMIT' } as const;
type LimitKey = keyof typeof LIMITS;

function readJsonc(path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) {
    const e = errors[0]!;
    throw new Error(`${path}: ${printParseErrorCode(e.error)} at offset ${e.offset}`);
  }
  return value;
}

export function toDeployment(raw: Record<string, unknown>, file = 'deployment'): Deployment {
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(id))
    throw new Error(`${file}: id must be lowercase letters, digits and dashes`);
  // OrderLoop's own deployments name their domain; a customer's comes from the id.
  if (RESERVED.has(id) && typeof raw.domain !== 'string')
    throw new Error(`${file}: "${id}" is reserved for OrderLoop; choose another id or set domain`);
  const ring = raw.ring as Ring;
  if (!RINGS.includes(ring)) throw new Error(`${file}: ring must be one of ${RINGS.join(', ')}`);
  if (!Number.isInteger(raw.slot) || (raw.slot as number) < 1 || (raw.slot as number) > 999)
    throw new Error(`${file}: slot must be an integer from 1 to 999`);
  if (raw.d1Id !== undefined && (typeof raw.d1Id !== 'string' || !raw.d1Id))
    throw new Error(`${file}: d1Id must be the D1 database's id`);
  if (raw.jurisdiction !== undefined && raw.jurisdiction !== 'eu' && raw.jurisdiction !== 'fedramp')
    throw new Error(`${file}: jurisdiction must be "eu" or "fedramp"`);
  const limits = raw.limits as Record<string, unknown> | undefined;
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null)
      throw new Error(`${file}: limits must be an object`);
    for (const [k, v] of Object.entries(limits)) {
      if (!(k in LIMITS))
        throw new Error(`${file}: limits.${k} is not one of ${Object.keys(LIMITS).join(', ')}`);
      if (!Number.isInteger(v) || (v as number) < 1)
        throw new Error(
          `${file}: limits.${k} must be a positive whole number of requests a minute`,
        );
    }
  }
  if (
    raw.aiPersonalData !== undefined &&
    raw.aiPersonalData !== 'redact' &&
    raw.aiPersonalData !== 'send'
  )
    throw new Error(`${file}: aiPersonalData must be "redact" or "send"`);
  if (raw.aiGatewayLogs !== undefined && typeof raw.aiGatewayLogs !== 'boolean')
    throw new Error(`${file}: aiGatewayLogs must be true or false`);
  const personal = raw.personalDataRetentionDays;
  if (personal !== undefined && (!Number.isInteger(personal) || (personal as number) < 30))
    throw new Error(
      `${file}: personalDataRetentionDays must be a whole number of days, at least 30`,
    );
  const archive = raw.auditArchiveDays;
  if (archive !== undefined && (!Number.isInteger(archive) || (archive as number) < 1))
    throw new Error(`${file}: auditArchiveDays must be a whole number of days`);
  const retention = raw.auditRetentionDays;
  if (retention !== undefined && (!Number.isInteger(retention) || (retention as number) < 90))
    throw new Error(`${file}: auditRetentionDays must be a whole number of days, at least 90`);
  return {
    id,
    ring,
    slot: raw.slot as number,
    domain: typeof raw.domain === 'string' ? raw.domain : `${id}.orderloop.app`,
    suffix: typeof raw.suffix === 'string' ? raw.suffix : `-${id}`,
    environment: typeof raw.environment === 'string' ? raw.environment : `deploy-${id}`,
    ...(raw.d1Id ? { d1Id: raw.d1Id as string } : {}),
    ...(raw.jurisdiction ? { jurisdiction: raw.jurisdiction as 'eu' | 'fedramp' } : {}),
    hold: raw.hold === true,
    docs: raw.docs === true,
    demo: raw.demo === true,
    ...(limits ? { limits: limits as Deployment['limits'] } : {}),
    ...(retention !== undefined ? { auditRetentionDays: retention as number } : {}),
    ...(personal !== undefined ? { personalDataRetentionDays: personal as number } : {}),
    ...(archive !== undefined ? { auditArchiveDays: archive as number } : {}),
    aiPersonalData: raw.aiPersonalData === 'send' ? 'send' : 'redact',
    aiGatewayLogs: raw.aiGatewayLogs !== false,
  };
}

export function loadDeployments(dir = join(ROOT, 'deployments')): Deployment[] {
  const list = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonc'))
    .sort()
    .map((f) => {
      const d = toDeployment(readJsonc(join(dir, f)), f);
      if (`${d.id}.jsonc` !== f) throw new Error(`${f}: id "${d.id}" must match the file name`);
      return d;
    });
  for (const key of ['slot', 'domain', 'suffix'] as const) {
    const seen = new Map<unknown, string>();
    for (const d of list) {
      const other = seen.get(d[key]);
      if (other) throw new Error(`${d.id} and ${other} share ${key} ${JSON.stringify(d[key])}`);
      seen.set(d[key], d.id);
    }
  }
  if (list.filter((d) => d.docs).length > 1) throw new Error('only one deployment sets docs');
  return list;
}

/** Resource names: the base name plus the deployment's suffix. */
export const names = (d: Deployment) => ({
  web: `orderloop-web${d.suffix}`,
  engine: `orderloop-engine${d.suffix}`,
  d1: `orderloop${d.suffix}`,
  r2: `orderloop-docs${d.suffix}`,
  aiGateway: `orderloop${d.suffix}`,
});

// biome-ignore lint/suspicious/noExplicitAny: a wrangler config is JSON read as is
type Config = Record<string, any>;

function storage(config: Config, d: Deployment) {
  if (!d.d1Id) throw new Error(`${d.id} has no d1Id: run scripts/provision.sh ${d.id}`);
  const n = names(d);
  config.d1_databases = config.d1_databases.map((db: Config) => ({
    ...db,
    database_name: n.d1,
    database_id: d.d1Id,
  }));
  config.r2_buckets = config.r2_buckets.map((b: Config) => ({
    ...b,
    bucket_name: n.r2,
    ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
  }));
}

export function renderEngine(base: Config, d: Deployment): Config {
  const config = structuredClone(base);
  config.name = names(d).engine;
  // Workflow names are unique per account, so each deployment's carry its suffix.
  config.workflows = config.workflows.map((w: Config) => ({ ...w, name: `${w.name}${d.suffix}` }));
  storage(config, d);
  config.vars = { ...config.vars, AI_GATEWAY_ID: names(d).aiGateway };
  if (d.auditRetentionDays)
    config.vars = { ...config.vars, AUDIT_RETENTION_DAYS: String(d.auditRetentionDays) };
  config.vars = { ...config.vars, AI_PERSONAL_DATA: d.aiPersonalData };
  // Durable Objects keep data where D1 and R2 do.
  if (d.jurisdiction) config.vars = { ...config.vars, DATA_JURISDICTION: d.jurisdiction };
  if (d.personalDataRetentionDays)
    config.vars = {
      ...config.vars,
      PERSONAL_DATA_RETENTION_DAYS: String(d.personalDataRetentionDays),
    };
  // A demo spends nothing on models and finishes a "3-day" wait in minutes, like local dev.
  if (d.demo)
    config.vars = { ...config.vars, AI_MODE: 'mock', AI_GATEWAY_ID: '', TIME_SCALE: '1440' };
  return config;
}

export function renderWeb(base: Config, d: Deployment): Config {
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.web;
  config.routes = [{ pattern: d.domain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  config.services = config.services.map((s: Config) =>
    s.binding === 'ENGINE' ? { ...s, service: n.engine } : s,
  );
  // Rate-limit namespaces are per account: slot 1 keeps the base ids (1001, 1002), slot 2 uses
  // 2001, 2002, and so on.
  // The registry's `limits` replace a binding's requests a minute; the period stays 60 seconds.
  const budgets = new Map(
    Object.entries(d.limits ?? {}).map(([k, v]) => [LIMITS[k as LimitKey] as string, v]),
  );
  config.ratelimits = config.ratelimits.map((r: Config) => ({
    ...r,
    namespace_id: String(d.slot * 1000 + (Number(r.namespace_id) % 1000)),
    ...(budgets.has(r.name) ? { simple: { ...r.simple, limit: budgets.get(r.name) } } : {}),
  }));
  storage(config, d);
  if (d.demo) config.vars = { ...config.vars, DEMO_MODE: 'true' };
  return config;
}

function byId(id: string | undefined): Deployment {
  const d = loadDeployments().find((x) => x.id === id);
  if (!d) throw new Error(`no deployment ${JSON.stringify(id)} in deployments/`);
  return d;
}

function render(id: string | undefined) {
  const d = byId(id);
  for (const [app, fn] of [
    ['engine', renderEngine],
    ['web', renderWeb],
  ] as const) {
    const out = join(ROOT, 'apps', app, `wrangler.${d.id}.json`);
    writeFileSync(
      out,
      `${JSON.stringify(fn(readJsonc(join(ROOT, 'apps', app, 'wrangler.jsonc')), d), null, 2)}\n`,
    );
    console.log(out);
  }
}

/** `{ staging: [...], internal: [...], ... }`, held deployments left out. */
export function matrix(list: Deployment[]): Record<Ring, Deployment[]> {
  const unprovisioned = list.filter((d) => !d.hold && !d.d1Id).map((d) => d.id);
  if (unprovisioned.length)
    throw new Error(
      `not provisioned (no d1Id): ${unprovisioned.join(', ')}; provision or hold them`,
    );
  return Object.fromEntries(
    RINGS.map((ring) => [ring, list.filter((d) => d.ring === ring && !d.hold)]),
  ) as Record<Ring, Deployment[]>;
}

function secrets(app: string | undefined, out: string | undefined) {
  if (app !== 'web' && app !== 'engine') throw new Error('secrets <engine|web> <out>');
  if (!out) throw new Error('secrets <engine|web> <out>');
  // Only the ones set: `--secrets-file` adds to a Worker's secrets and never removes one.
  const values = Object.fromEntries(
    SECRETS[app].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`${app}: ${Object.keys(values).join(', ') || 'no secrets set'}`);
}

function shellNames(id: string | undefined) {
  const d = byId(id);
  const n = names(d);
  const vars = {
    WEB: n.web,
    D1: n.d1,
    R2: n.r2,
    AI_GATEWAY: n.aiGateway,
    DOMAIN: d.domain,
    ENVIRONMENT: d.environment,
    JURISDICTION: d.jurisdiction ?? '',
    AI_GATEWAY_LOGS: String(d.aiGatewayLogs),
    AUDIT_ARCHIVE_DAYS: String(d.auditArchiveDays ?? ''),
  };
  for (const [k, v] of Object.entries(vars)) console.log(`${k}='${v}'`);
}

/** Writes `d1Id` into deployments/<id>.jsonc, keeping its comments. */
function setD1(id: string | undefined, uuid: string | undefined) {
  const d = byId(id);
  if (!uuid || !/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('set-d1 <id> <uuid>');
  const file = join(ROOT, 'deployments', `${d.id}.jsonc`);
  const text = readFileSync(file, 'utf8');
  const edits = modify(text, ['d1Id'], uuid, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

async function status() {
  for (const d of loadDeployments()) {
    let health = 'unreachable';
    try {
      const r = await fetch(`https://${d.domain}/health/deep`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json()) as { ok: boolean; checks: Record<string, string> };
      const failed = Object.entries(body.checks)
        .filter(([, s]) => s !== 'ok')
        .map(([k]) => k);
      health = body.ok ? 'ok' : `fail (${failed.join(', ')})`;
    } catch {}
    const flags = [d.hold && 'hold', d.jurisdiction].filter(Boolean).join(' ');
    console.log([d.id.padEnd(16), d.ring.padEnd(9), d.domain.padEnd(28), health, flags].join(' '));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'render') render(args[0]);
    else if (cmd === 'matrix') console.log(JSON.stringify(matrix(loadDeployments())));
    else if (cmd === 'secrets') secrets(args[0], args[1]);
    else if (cmd === 'status') await status();
    else if (cmd === 'names') shellNames(args[0]);
    else if (cmd === 'set-d1') setD1(args[0], args[1]);
    else if (cmd === 'demos')
      console.log(JSON.stringify(loadDeployments().filter((d) => d.demo && d.d1Id)));
    else
      throw new Error('usage: fleet.ts render|matrix|secrets|status|names|set-d1 (see the header)');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
