/**
 * The fleet: one OrderLoop deployment per customer, each listed in deployments/<id>.jsonc.
 *
 *   node scripts/fleet.ts render <id>             write apps/{catalog,catalog-edge,engine,web}/wrangler.<id>.json
 *                                                 and plugins/<plugin>/wrangler.<id>.json for each plugin
 *   node scripts/fleet.ts matrix                  print the deployments of each ring for CI
 *   node scripts/fleet.ts secrets <engine|web> <out>  write this app's secrets from the environment
 *   node scripts/fleet.ts secrets plugin <out> <plugin> [id]  write a plugin's own keys, derived, and
 *                                                 its PLUGIN_<ID>_* secrets from ENV_SECRETS (none
 *                                                 when deployment <id> has a Secrets Store)
 *   node scripts/fleet.ts secrets sandboxed <engine secrets file> <id>  add PLUGIN_SECRETS for its
 *                                                 sandboxed plugins (shared account)
 *   node scripts/fleet.ts check-plugin-secrets <id> <plugin> <manifest.json>  fail if a secret the
 *                                                 plugin needs isn't set (STORE_SECRET_NAMES or ENV_SECRETS)
 *   node scripts/fleet.ts status                  deep health of every deployment
 *   node scripts/fleet.ts names <id>              resource names, as shell variables (provisioning)
 *   node scripts/fleet.ts set-d1 <id> <uuid>      record the D1 database id in the registry
 *   node scripts/fleet.ts set-catalog-kv <id> <kv id>  record the catalog's card KV namespace id
 *   node scripts/fleet.ts set-plugin-d1 <id> <plugin> <uuid>  record a plugin's D1 database id
 *   node scripts/fleet.ts demos                   the provisioned demo deployments, for the nightly reset
 *
 * A rendered config is the app's wrangler.jsonc with the deployment's names, ids and domain put
 * in, written next to it so its relative paths still resolve. See docs/operations.md.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  web: [
    'PRINCIPAL_KEY',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'SETUP_TOKEN',
    'SHOPIFY_WEBHOOK_SECRET',
    'SHOPIFY_SHOPS',
    'STRIPE_WEBHOOK_SECRET',
    'OIDC_CLIENT_SECRET',
  ],
  engine: [
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'INTAKE_ALLOWLIST',
    'SHIPPING_CARRIER_AUTH',
    'STRIPE_SECRET_KEY',
    'UCP_SIGNING_KEY',
  ],
} as const;

/**
 * Secrets a deploy can't go without, so without them in the environment the deploy stops here,
 * before migrating anything. PRINCIPAL_KEY signs every request the web Worker forwards to the
 * engine; DATA_KEY encrypts the secrets both Workers store (two-factor, webhook and integration
 * secrets, A2A push credentials).
 */
const REQUIRED_SECRETS = ['PRINCIPAL_KEY', 'DATA_KEY'] as const;

/** The shared keys, and the ones before them during a rotation: each at least this long. */
const KEYS = ['PRINCIPAL_KEY', 'PRINCIPAL_KEY_PREVIOUS', 'DATA_KEY', 'DATA_KEY_PREVIOUS'] as const;
export const MIN_KEY_LENGTH = 32;

/**
 * Why the shared keys can't be used, or null: one set but shorter than `MIN_KEY_LENGTH`
 * characters is guessable offline from anything it signed. `provision.sh` makes 64 hex digits.
 */
export function keysProblem(env: Record<string, string | undefined>): string | null {
  const short = KEYS.filter((k) => env[k] && env[k]!.length < MIN_KEY_LENGTH);
  return short.length
    ? `${short.join(', ')} must be at least ${MIN_KEY_LENGTH} characters (openssl rand -hex 32)`
    : null;
}

export type Deployment = {
  id: string;
  ring: Ring;
  /** Unique per deployment: keeps each one's rate-limit counters apart. */
  slot: number;
  /** Defaults to `<id>.orderloop.app`. */
  domain: string;
  /** The public catalog API's host. Defaults to `catalog.<domain>`. */
  catalogDomain: string;
  /** Appended to every resource name. Defaults to `-<id>`; orderloop.app's own is `""`. */
  suffix: string;
  /** The GitHub environment holding this deployment's secrets. Defaults to `deploy-<id>`. */
  environment: string;
  /** Set by scripts/provision.sh; required to render or deploy. */
  d1Id?: string;
  /** The catalog's card KV namespace id. Set by scripts/provision.sh; required like d1Id. */
  catalogKvId?: string;
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
  /** Model tokens a person's assistant may use a day (0: no limit); unset keeps the base. */
  assistantDailyTokens?: number;
  /** `send` lets workflow AI nodes see buyers' personal data; the default, `redact`, doesn't. */
  aiPersonalData: 'redact' | 'send';
  /** Whether the AI Gateway keeps request logs (prompts and responses). Default true. */
  aiGatewayLogs: boolean;
  /**
   * The customer's OpenID Connect identity provider for single sign-on: its issuer (https, as its
   * discovery document names it) and this deployment's client id. The client secret is the
   * environment's OIDC_CLIENT_SECRET; the redirect URI to register is https://<domain>/login/sso/callback.
   */
  sso?: { issuer: string; clientId: string; trustEmail?: boolean };
  /**
   * How the engine takes payments: `mock` (the default) records them without taking money;
   * `stripe` authorizes, captures and refunds through Stripe with the environment's
   * STRIPE_SECRET_KEY, which a deploy then requires.
   */
  payments: 'mock' | 'stripe';
  /**
   * The Stripe publishable key (pk_…) of the same account and mode as STRIPE_SECRET_KEY. Agentic
   * checkout's Stripe payment handler gives it to platforms to tokenize cards with; without it no
   * handler is offered. Only with `payments: "stripe"`.
   */
  stripePublishableKey?: string;
  /**
   * Installed plugins (plugins/<id>/). A `worker` plugin (the default `runtime`) has its own Worker
   * and D1 database, bound to the engine and the web Worker as PLUGIN_<ID>; `d1Id` is set by
   * scripts/provision.sh. A `sandboxed` one is a bundle CI publishes to the deployment's DOCS
   * bucket, pinned in the engine's PLUGIN_BUNDLES, and loaded by the engine; it needs no Worker,
   * binding or database of its own. `secrets` names the plugin's secrets, needed with
   * `secretsStore`. Removing an entry uninstalls the plugin on the next deploy; see docs/plugins.md.
   */
  plugins: Record<string, PluginEntry>;
  /**
   * The deployment's Cloudflare Secrets Store, for a deployment on its own Cloudflare account:
   * plugin secrets are then read from it (as PLUGIN_<ID>_<NAME>) instead of the GitHub environment.
   * Leave it out on a shared account (one store and 100 secrets an account).
   */
  secretsStore?: { storeId: string };
  /**
   * Runtime installs: an admin may install a sandboxed plugin from its Plugins page when its bundle
   * is signed by one of these publishers (name → Ed25519 public key, raw 32 bytes, base64url, as
   * `pnpm plugin:pack keygen` prints it). Absent, runtime installs are off. `assistant: true` also
   * lets the workspace assistant draft business-rule plugins for an admin to review and approve.
   */
  pluginInstalls?: { publishers?: Record<string, string>; assistant?: true };
};

/** What a plugin may ask of the core through ORDERLOOP (`PLUGIN_CAPABILITIES` in core). */
const PLUGIN_CAPABILITIES = ['carts:external', 'orders:start', 'orders:cancel'];

/**
 * Top-level path segments the web app serves itself: its pages (apps/web/app/routes.ts) and what
 * its Worker answers before them (apps/web/workers/app.ts). A plugin alias may not be one of them;
 * fleet.test.ts reads both files so a new route can't be missed.
 */
export const RESERVED_PATH_SEGMENTS = new Set([
  'account',
  'agents',
  'api',
  'approvals',
  'assets',
  'audit',
  'a2a',
  'cart',
  'carts',
  'commerce',
  'docs',
  'flows',
  'health',
  'login',
  'logout',
  'mcp',
  'oauth',
  'orders',
  'plugins',
  'promotions',
  'scim',
  'setup',
  'team',
  'ucp',
]);

/** A plugin alias: one lowercase path segment, as `/<segment>/`. */
const ALIAS_RE = /^\/([a-z][a-z0-9-]{1,30})\/$/;

export type PluginEntry = {
  /** Another path the plugin's pages answer at, besides `/plugins/<id>/` (e.g. `/punchout/`). */
  alias?: string;
  d1Id?: string;
  personalData?: 'send';
  capabilities?: string[];
  runtime?: 'worker' | 'sandboxed';
  secrets?: string[];
};

/** Ids whose binding would be one of the engine's plugin variables (`RESERVED_IDS` in core). */
const RESERVED_PLUGIN_IDS = new Set([
  'bundles',
  'secrets',
  'grants',
  'key',
  'storage',
  'dev-bundles',
  'publishers',
]);

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

/** How a deployment runs a plugin. */
export const runtimeOf = (d: Deployment, p: string) => d.plugins[p]?.runtime ?? 'worker';
export const workerPlugins = (d: Deployment) =>
  Object.keys(d.plugins)
    .filter((p) => runtimeOf(d, p) === 'worker')
    .sort();
export const sandboxedPlugins = (d: Deployment) =>
  Object.keys(d.plugins)
    .filter((p) => runtimeOf(d, p) === 'sandboxed')
    .sort();

/** Test fixtures in plugins/ that no deployment may install. */
const FIXTURE_PLUGINS = new Set(['example', 'fixture-carrier']);

/** A plugin's binding name, as `pluginBinding` in @orderloop/core makes it: "qbd-sync" → "PLUGIN_QBD_SYNC". */
export const pluginBinding = (id: string) => `PLUGIN_${id.toUpperCase().replaceAll('-', '_')}`;

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
  if (typeof id !== 'string' || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(id))
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
  if (
    raw.catalogDomain !== undefined &&
    (typeof raw.catalogDomain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw.catalogDomain))
  )
    throw new Error(`${file}: catalogDomain must be a host name`);
  if (
    raw.catalogKvId !== undefined &&
    (typeof raw.catalogKvId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.catalogKvId))
  )
    throw new Error(`${file}: catalogKvId must be the KV namespace's 32-character id`);
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
  const tokens = raw.assistantDailyTokens;
  if (tokens !== undefined && (!Number.isInteger(tokens) || (tokens as number) < 0))
    throw new Error(`${file}: assistantDailyTokens must be a whole number (0 for no limit)`);
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
  const sso = raw.sso as Record<string, unknown> | undefined;
  if (sso !== undefined) {
    if (typeof sso !== 'object' || sso === null)
      throw new Error(`${file}: sso must be { "issuer", "clientId" }`);
    if (typeof sso.issuer !== 'string' || !/^https:\/\/[^\s]+$/.test(sso.issuer))
      throw new Error(`${file}: sso.issuer must be the identity provider's https issuer URL`);
    if (typeof sso.clientId !== 'string' || !sso.clientId.trim())
      throw new Error(`${file}: sso.clientId must be the client id the provider issued`);
    if (sso.trustEmail !== undefined && typeof sso.trustEmail !== 'boolean')
      throw new Error(`${file}: sso.trustEmail must be true or false`);
  }
  if (raw.payments !== undefined && raw.payments !== 'mock' && raw.payments !== 'stripe')
    throw new Error(`${file}: payments must be "mock" or "stripe"`);
  const payments = raw.payments === 'stripe' ? 'stripe' : 'mock';
  if (payments === 'stripe' && raw.demo === true)
    throw new Error(`${file}: a demo takes no real payments; leave payments "mock"`);
  const pk = raw.stripePublishableKey;
  if (pk !== undefined) {
    if (typeof pk !== 'string' || !/^pk_(test|live)_\w+$/.test(pk))
      throw new Error(
        `${file}: stripePublishableKey must be a Stripe publishable key (pk_test_… or pk_live_…)`,
      );
    if (payments !== 'stripe')
      throw new Error(`${file}: stripePublishableKey needs payments "stripe"`);
  }
  const plugins = raw.plugins ?? {};
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins))
    throw new Error(`${file}: plugins must be an object of plugin id → { "d1Id"? }`);
  for (const [p, v] of Object.entries(plugins as Record<string, unknown>)) {
    if (!/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(p))
      throw new Error(
        `${file}: plugins.${p} is not a plugin id (lowercase letters, digits, dashes)`,
      );
    if (FIXTURE_PLUGINS.has(p)) throw new Error(`${file}: plugins.${p} is a test fixture`);
    if (RESERVED_PLUGIN_IDS.has(p)) throw new Error(`${file}: plugins.${p} is a reserved id`);
    const rt = (v as { runtime?: unknown } | null)?.runtime;
    if (rt !== undefined && rt !== 'worker' && rt !== 'sandboxed')
      throw new Error(`${file}: plugins.${p}.runtime must be "worker" or "sandboxed"`);
    const names = (v as { secrets?: unknown } | null)?.secrets;
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        names.some(
          (n) => typeof n !== 'string' || !SECRET_NAME_RE.test(n) || PLUGIN_RESERVED_ENV.has(n),
        ))
    )
      throw new Error(`${file}: plugins.${p}.secrets must be a list of secret names (upper case)`);
    if (rt === 'sandboxed' && (v as { d1Id?: unknown }).d1Id !== undefined)
      throw new Error(`${file}: plugins.${p} is sandboxed: it has no D1 database (drop d1Id)`);
    const d1 = (v as { d1Id?: unknown } | null)?.d1Id;
    const pd = (v as { personalData?: unknown } | null)?.personalData;
    if (pd !== undefined && pd !== 'send')
      throw new Error(
        `${file}: plugins.${p}.personalData can only be "send" (to grant buyer details)`,
      );
    const alias = (v as { alias?: unknown } | null)?.alias;
    if (alias !== undefined) {
      const seg = typeof alias === 'string' ? ALIAS_RE.exec(alias)?.[1] : undefined;
      if (!seg)
        throw new Error(
          `${file}: plugins.${p}.alias must be one lowercase path segment, like "/${p}/"`,
        );
      if (RESERVED_PATH_SEGMENTS.has(seg))
        throw new Error(`${file}: plugins.${p}.alias "${alias}" is one of the app's own paths`);
      const taken = Object.entries(plugins as Record<string, { alias?: unknown }>).find(
        ([q, w]) => q !== p && w?.alias === alias,
      );
      if (taken) throw new Error(`${file}: plugins.${p}.alias "${alias}" is also ${taken[0]}'s`);
    }
    const caps = (v as { capabilities?: unknown } | null)?.capabilities;
    if (
      caps !== undefined &&
      (!Array.isArray(caps) ||
        caps.some((c) => !PLUGIN_CAPABILITIES.includes(c as string)) ||
        new Set(caps).size !== caps.length)
    )
      throw new Error(
        `${file}: plugins.${p}.capabilities must list each of ${PLUGIN_CAPABILITIES.join(', ')} at most once`,
      );
    const extra = Object.keys((v as object) ?? {}).filter(
      (k) => !['alias', 'd1Id', 'personalData', 'capabilities', 'runtime', 'secrets'].includes(k),
    );
    if (extra.length)
      throw new Error(`${file}: plugins.${p} has unknown keys: ${extra.join(', ')}`);
    if (
      typeof v !== 'object' ||
      v === null ||
      (d1 !== undefined && (typeof d1 !== 'string' || !d1))
    )
      throw new Error(
        `${file}: plugins.${p} must be { "alias"?, "d1Id"?, "personalData"?, "capabilities"?, "runtime"?, "secrets"? }`,
      );
  }
  const installs = raw.pluginInstalls;
  if (installs !== undefined) {
    const i = (installs ?? {}) as { publishers?: unknown; assistant?: unknown };
    const pubs = i.publishers;
    const keys = typeof installs === 'object' && installs !== null ? Object.keys(installs) : [];
    if (
      typeof installs !== 'object' ||
      installs === null ||
      !keys.length ||
      keys.some((k) => k !== 'publishers' && k !== 'assistant') ||
      (i.assistant !== undefined && i.assistant !== true) ||
      (pubs !== undefined &&
        (typeof pubs !== 'object' ||
          pubs === null ||
          Array.isArray(pubs) ||
          !Object.keys(pubs).length ||
          Object.entries(pubs).some(
            ([n, k]) =>
              !/^[a-z][a-z0-9-]{0,39}$/.test(n) ||
              // Reserved: the assistant's drafts are staged as "assistant", trusted by `assistant`.
              n === 'assistant' ||
              typeof k !== 'string' ||
              !/^[A-Za-z0-9_-]{43}$/.test(k),
          )))
    )
      throw new Error(
        `${file}: pluginInstalls must be { "publishers"?: { "<name>": "<Ed25519 public key, base64url>" }, "assistant"?: true }, with at least one (a publisher can't be named "assistant")`,
      );
  }
  const store = raw.secretsStore;
  if (
    store !== undefined &&
    (typeof store !== 'object' ||
      store === null ||
      Object.keys(store).join() !== 'storeId' ||
      typeof (store as { storeId?: unknown }).storeId !== 'string' ||
      !/^[0-9a-f]{32}$/.test((store as { storeId: string }).storeId))
  )
    throw new Error(`${file}: secretsStore must be { "storeId": "<32 hex characters>" }`);
  // A plugin's secrets are PLUGIN_<ID>_<NAME>, so with ids "a" and "a-b" both installed,
  // PLUGIN_A_B_X would be a's B_X and b's X at once.
  for (const a of Object.keys(plugins))
    for (const b of Object.keys(plugins))
      if (a !== b && pluginBinding(b).startsWith(`${pluginBinding(a)}_`))
        throw new Error(
          `${file}: plugins ${a} and ${b} can't both be installed: ${pluginBinding(b)}_* secrets would also reach ${a}`,
        );
  return {
    id,
    ring,
    slot: raw.slot as number,
    domain: typeof raw.domain === 'string' ? raw.domain : `${id}.orderloop.app`,
    catalogDomain:
      typeof raw.catalogDomain === 'string'
        ? raw.catalogDomain
        : `catalog.${typeof raw.domain === 'string' ? raw.domain : `${id}.orderloop.app`}`,
    suffix: typeof raw.suffix === 'string' ? raw.suffix : `-${id}`,
    environment: typeof raw.environment === 'string' ? raw.environment : `deploy-${id}`,
    ...(raw.d1Id ? { d1Id: raw.d1Id as string } : {}),
    ...(raw.catalogKvId ? { catalogKvId: raw.catalogKvId as string } : {}),
    ...(raw.jurisdiction ? { jurisdiction: raw.jurisdiction as 'eu' | 'fedramp' } : {}),
    hold: raw.hold === true,
    docs: raw.docs === true,
    demo: raw.demo === true,
    ...(limits ? { limits: limits as Deployment['limits'] } : {}),
    ...(retention !== undefined ? { auditRetentionDays: retention as number } : {}),
    ...(personal !== undefined ? { personalDataRetentionDays: personal as number } : {}),
    ...(tokens !== undefined ? { assistantDailyTokens: tokens as number } : {}),
    ...(archive !== undefined ? { auditArchiveDays: archive as number } : {}),
    aiPersonalData: raw.aiPersonalData === 'send' ? 'send' : 'redact',
    aiGatewayLogs: raw.aiGatewayLogs !== false,
    ...(sso
      ? {
          sso: {
            issuer: sso.issuer as string,
            clientId: sso.clientId as string,
            ...(sso.trustEmail === true ? { trustEmail: true } : {}),
          },
        }
      : {}),
    payments,
    ...(pk !== undefined ? { stripePublishableKey: pk as string } : {}),
    plugins: plugins as Deployment['plugins'],
    ...(store ? { secretsStore: { storeId: (store as { storeId: string }).storeId } } : {}),
    ...(installs ? { pluginInstalls: installs as Deployment['pluginInstalls'] & object } : {}),
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
  for (const d of list)
    for (const p of workerPlugins(d))
      if (!existsSync(join(ROOT, 'plugins', p, 'wrangler.jsonc')))
        throw new Error(`${d.id}: plugin "${p}" has no plugins/${p}/wrangler.jsonc`);
  return list;
}

/** Resource names: the base name plus the deployment's suffix. */
export const names = (d: Deployment) => ({
  web: `orderloop-web${d.suffix}`,
  engine: `orderloop-engine${d.suffix}`,
  d1: `orderloop${d.suffix}`,
  r2: `orderloop-docs${d.suffix}`,
  aiGateway: `orderloop${d.suffix}`,
  catalog: `orderloop-catalog${d.suffix}`,
  catalogR2: `orderloop-catalog${d.suffix}`,
  catalogKv: `orderloop-catalog-cards${d.suffix}`,
  catalogFeedParts: `orderloop-catalog-feed-parts${d.suffix}`,
  catalogFeedPartsDlq: `orderloop-catalog-feed-parts-dlq${d.suffix}`,
  catalogEdge: `orderloop-catalog-edge${d.suffix}`,
  catalogPurge: `orderloop-catalog-purge${d.suffix}`,
  catalogChanges: `orderloop-catalog-changes${d.suffix}`,
  catalogChangesDlq: `orderloop-catalog-changes-dlq${d.suffix}`,
  catalogPurgeDlq: `orderloop-catalog-purge-dlq${d.suffix}`,
  // Analytics Engine dataset names allow letters, digits and underscores.
  catalogEdgeDataset: `orderloop_catalog_edge${d.suffix.replaceAll('-', '_')}`,
  /** A plugin's Worker and its D1 database share a name. */
  plugin: (p: string) => `orderloop-plugin-${p}${d.suffix}`,
});

/** The engine's and web Worker's service bindings to the deployment's Worker plugins. */
function pluginServices(d: Deployment) {
  return workerPlugins(d).map((p) => ({ binding: pluginBinding(p), service: names(d).plugin(p) }));
}

/** A plugin secret's name in the deployment's Secrets Store (and its GitHub environment). */
export const pluginSecretVar = (p: string, name: string) => `${pluginBinding(p)}_${name}`;

/** The engine's binding for a sandboxed plugin's secret in the Secrets Store (`storeBinding`). */
export const storeBinding = (p: string, name: string) =>
  `PLUGIN_SECRET_${pluginBinding(p).slice('PLUGIN_'.length)}__${name}`;

/** Secrets Store bindings: `binding(name)` for each of these plugins' listed secrets. */
function storeSecrets(d: Deployment, plugins: string[], binding: (p: string, n: string) => string) {
  const storeId = d.secretsStore?.storeId;
  if (!storeId) return [];
  return plugins.flatMap((p) =>
    (d.plugins[p]?.secrets ?? []).map((n) => ({
      binding: binding(p, n),
      store_id: storeId,
      secret_name: pluginSecretVar(p, n),
    })),
  );
}

/**
 * What a plugin's wrangler.jsonc may hold. Anything else (service bindings, Durable Objects,
 * buckets, queues, routes…) could reach the engine or another deployment's resources, so a plugin
 * that asks for it is refused rather than deployed.
 */
const PLUGIN_CONFIG_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'observability',
  'upload_source_maps',
  'vars',
  'd1_databases',
]);

export function renderPlugin(base: Config, d: Deployment, p: string): Config {
  if (runtimeOf(d, p) !== 'worker') throw new Error(`${d.id}: plugin ${p} is sandboxed: no Worker`);
  const d1Id = d.plugins[p]?.d1Id;
  if (!d1Id) throw new Error(`${d.id}: plugin ${p} has no d1Id: run scripts/provision.sh ${d.id}`);
  const extra = Object.keys(base).filter((k) => !PLUGIN_CONFIG_KEYS.has(k));
  if (extra.length)
    throw new Error(
      `plugins/${p}/wrangler.jsonc: a plugin may not declare ${extra.join(', ')}; it gets one D1 database and vars`,
    );
  const dbs = (base.d1_databases ?? []) as Config[];
  if (dbs.length > 1 || (dbs[0] && dbs[0].binding !== 'DB'))
    throw new Error(`plugins/${p}/wrangler.jsonc: a plugin has one D1 binding, named DB`);
  const config = structuredClone(base);
  config.name = names(d).plugin(p);
  config.workers_dev = false;
  config.preview_urls = false;
  config.d1_databases = dbs.map((db) => ({
    ...db,
    database_name: names(d).plugin(p),
    database_id: d1Id,
  }));
  // On its own account, the deployment's Secrets Store holds the plugin's secrets: each is bound
  // under its own name (`secret()` in the SDK reads either kind).
  const store = storeSecrets(d, [p], (_p, n) => n);
  if (store.length) config.secrets_store_secrets = store;
  // The core's host API, as this plugin: props name it, so it can't act as another. Bound only
  // when the deployment grants it a capability; the engine checks the grant on every call.
  if (d.plugins[p]?.capabilities?.length)
    config.services = [
      {
        binding: 'ORDERLOOP',
        service: names(d).engine,
        entrypoint: 'PluginHost',
        props: { id: p },
      },
    ];
  return config;
}

/**
 * A plugin's own page-signing key: the HMAC of the deployment's principal key with its id, as
 * `pluginKey` in @orderloop/core computes it (fleet.test.ts holds the two to the same vector). The
 * plugin never gets the principal key itself.
 */
export const pluginKey = (principalKey: string, id: string) =>
  createHmac('sha256', principalKey).update(`orderloop-plugin:${id}`).digest('hex');

/** What the engine grants plugins beyond the defaults, from the registry: buyer details, capabilities. */
function pluginGrants(d: Deployment) {
  const grants = Object.fromEntries(
    Object.entries(d.plugins).flatMap(([p, v]) => {
      const g = {
        ...(v.personalData === 'send' ? { personalData: 'send' } : {}),
        ...(v.capabilities?.length ? { capabilities: v.capabilities } : {}),
      };
      return Object.keys(g).length ? [[p, g]] : [];
    }),
  );
  return Object.keys(grants).length ? JSON.stringify(grants) : '';
}

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
  const plugins = pluginServices(d);
  if (plugins.length) config.services = [...(config.services ?? []), ...plugins];
  const grants = pluginGrants(d);
  // Always set, so a deployment that grants nothing doesn't keep the base config's grants.
  config.vars = { ...config.vars, PLUGIN_GRANTS: grants };
  // The publishers whose signed bundles an admin may install at runtime.
  if (d.pluginInstalls?.publishers)
    config.vars = {
      ...config.vars,
      PLUGIN_PUBLISHERS: JSON.stringify(d.pluginInstalls.publishers),
    };
  // Whether the assistant may draft business-rule plugins for an admin to approve. The base config
  // has orderloop.app's "on", so a deployment that doesn't ask for it must not keep it.
  const { ASSISTANT_PLUGINS: _drafts, ...vars } = config.vars;
  config.vars = d.pluginInstalls?.assistant ? { ...vars, ASSISTANT_PLUGINS: 'on' } : vars;
  // Sandboxed plugins' secrets, on a deployment with its own Secrets Store (else PLUGIN_SECRETS,
  // a secret the deploy writes). PLUGIN_BUNDLES is added by the deploy once it has published them.
  const store = storeSecrets(d, sandboxedPlugins(d), storeBinding);
  if (store.length)
    config.secrets_store_secrets = [...(config.secrets_store_secrets ?? []), ...store];
  config.vars = { ...config.vars, AI_GATEWAY_ID: names(d).aiGateway };
  // The app's own origin (for links the engine hands out, an external cart's start link) and the
  // hosts it serves, which an external cart must never post back to.
  config.vars = {
    ...config.vars,
    APP_ORIGIN: `https://${d.domain}`,
    OWN_HOSTS: [d.domain, d.catalogDomain].join(','),
  };
  if (d.auditRetentionDays)
    config.vars = { ...config.vars, AUDIT_RETENTION_DAYS: String(d.auditRetentionDays) };
  config.vars = { ...config.vars, AI_PERSONAL_DATA: d.aiPersonalData };
  if (d.assistantDailyTokens !== undefined)
    config.vars = { ...config.vars, ASSISTANT_DAILY_TOKENS: String(d.assistantDailyTokens) };
  // Durable Objects keep data where D1 and R2 do.
  if (d.jurisdiction) config.vars = { ...config.vars, DATA_JURISDICTION: d.jurisdiction };
  if (d.personalDataRetentionDays)
    config.vars = {
      ...config.vars,
      PERSONAL_DATA_RETENTION_DAYS: String(d.personalDataRetentionDays),
    };
  config.vars = {
    ...config.vars,
    PAYMENTS_MODE: d.payments,
    STRIPE_PUBLISHABLE_KEY: d.stripePublishableKey ?? '',
  };
  // A demo spends nothing on models, finishes a "3-day" wait in minutes and runs the failing
  // scenarios, like local dev.
  if (d.demo)
    config.vars = {
      ...config.vars,
      AI_MODE: 'mock',
      AI_GATEWAY_ID: '',
      TIME_SCALE: '1440',
      SIMULATE_FAILURES: 'true',
    };
  return config;
}

export function renderCatalog(base: Config, d: Deployment): Config {
  if (!d.catalogKvId)
    throw new Error(`${d.id} has no catalogKvId: run scripts/provision.sh ${d.id}`);
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.catalog;
  config.r2_buckets = config.r2_buckets.map((b: Config) => ({
    ...b,
    bucket_name: n.catalogR2,
    ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
  }));
  config.kv_namespaces = config.kv_namespaces.map((k: Config) =>
    k.binding === 'CARDS' ? { ...k, id: d.catalogKvId } : k,
  );
  // Order Loop's own database, for the variant names and prices the catalog keeps in `products`.
  if (!d.d1Id) throw new Error(`${d.id} has no d1Id: run scripts/provision.sh ${d.id}`);
  config.d1_databases = config.d1_databases.map((db: Config) => ({
    ...db,
    database_name: n.d1,
    database_id: d.d1Id,
  }));
  // Workflow and queue names are unique per account, so each deployment's carry its suffix.
  config.workflows = config.workflows.map((w: Config) => ({ ...w, name: `${w.name}${d.suffix}` }));
  const queue = (name: string) => `${name}${d.suffix}`;
  config.queues = {
    producers: config.queues.producers.map((p: Config) => ({ ...p, queue: queue(p.queue) })),
    consumers: config.queues.consumers.map((c: Config) => ({
      ...c,
      queue: queue(c.queue),
      ...(c.dead_letter_queue ? { dead_letter_queue: queue(c.dead_letter_queue) } : {}),
    })),
  };
  // The shards keep their data where the deployment's other data lives.
  if (d.jurisdiction) config.vars = { ...config.vars, DATA_JURISDICTION: d.jurisdiction };
  return config;
}

export function renderCatalogEdge(base: Config, d: Deployment): Config {
  if (!d.catalogKvId)
    throw new Error(`${d.id} has no catalogKvId: run scripts/provision.sh ${d.id}`);
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.catalogEdge;
  config.routes = [{ pattern: d.catalogDomain, custom_domain: true }];
  config.services = config.services.map((s: Config) =>
    s.binding === 'CATALOG' ? { ...s, service: n.catalog } : s,
  );
  config.r2_buckets = config.r2_buckets.map((b: Config) => ({
    ...b,
    bucket_name: n.catalogR2,
    ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
  }));
  config.kv_namespaces = config.kv_namespaces.map((k: Config) =>
    k.binding === 'CARDS' ? { ...k, id: d.catalogKvId } : k,
  );
  config.queues = {
    consumers: config.queues.consumers.map((c: Config) => ({
      ...c,
      queue: `${c.queue}${d.suffix}`,
      ...(c.dead_letter_queue ? { dead_letter_queue: `${c.dead_letter_queue}${d.suffix}` } : {}),
    })),
  };
  config.analytics_engine_datasets = config.analytics_engine_datasets.map((a: Config) => ({
    ...a,
    dataset: n.catalogEdgeDataset,
  }));
  return config;
}

export function renderWeb(base: Config, d: Deployment): Config {
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.web;
  config.routes = [{ pattern: d.domain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  config.services = [
    ...config.services.map((s: Config) =>
      s.binding === 'ENGINE'
        ? { ...s, service: n.engine }
        : s.binding === 'CATALOG'
          ? { ...s, service: n.catalog }
          : s,
    ),
    ...pluginServices(d),
  ];
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
  // Plugins' aliases, alias → plugin id; always set, so one deployment's never carries over.
  const aliases = Object.fromEntries(
    Object.entries(d.plugins).flatMap(([p, v]) => (v.alias ? [[v.alias, p]] : [])),
  );
  config.vars = {
    ...config.vars,
    PLUGIN_ALIASES: Object.keys(aliases).length ? JSON.stringify(aliases) : '',
  };
  if (d.demo) config.vars = { ...config.vars, DEMO_MODE: 'true' };
  if (d.sso)
    config.vars = {
      ...config.vars,
      OIDC_ISSUER: d.sso.issuer,
      OIDC_CLIENT_ID: d.sso.clientId,
      OIDC_TRUST_EMAIL: d.sso.trustEmail ? 'true' : '',
    };
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
    ['catalog', renderCatalog],
    ['catalog-edge', renderCatalogEdge],
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
  for (const p of workerPlugins(d)) {
    const out = join(ROOT, 'plugins', p, `wrangler.${d.id}.json`);
    const base = readJsonc(join(ROOT, 'plugins', p, 'wrangler.jsonc'));
    writeFileSync(out, `${JSON.stringify(renderPlugin(base, d, p), null, 2)}\n`);
    console.log(out);
  }
}

/** `{ staging: [...], internal: [...], ... }`, held deployments left out. */
export function matrix(list: Deployment[]): Record<Ring, Deployment[]> {
  const unprovisioned = list
    .filter(
      (d) =>
        !d.hold && (!d.d1Id || !d.catalogKvId || workerPlugins(d).some((p) => !d.plugins[p]!.d1Id)),
    )
    .map((d) => d.id);
  if (unprovisioned.length)
    throw new Error(
      `not provisioned (no d1Id, catalogKvId or plugin d1Id): ${unprovisioned.join(', ')}; provision or hold them`,
    );
  return Object.fromEntries(
    RINGS.map((ring) => [ring, list.filter((d) => d.ring === ring && !d.hold)]),
  ) as Record<Ring, Deployment[]>;
}

/**
 * Why the environment's secrets can't run `d`, or null: a Stripe deployment needs
 * STRIPE_SECRET_KEY, in the same mode (test or live) as its publishable key.
 */
export function secretsProblem(d: Deployment, env: Record<string, string | undefined>) {
  if (d.payments !== 'stripe') return null;
  const sk = env.STRIPE_SECRET_KEY;
  if (!sk)
    return `${d.id} takes payments through Stripe: add STRIPE_SECRET_KEY to its GitHub environment`;
  const live = (k: string) => /^(sk|rk|pk)_live_/.test(k);
  if (d.stripePublishableKey && live(sk) !== live(d.stripePublishableKey))
    return `${d.id}: STRIPE_SECRET_KEY and stripePublishableKey are not both test or both live keys`;
  return null;
}

function secrets(app: string | undefined, out: string | undefined, id?: string, more?: string) {
  const usage = 'secrets <engine|web|plugin|sandboxed> <out> [id | plugin id]';
  if (app !== 'web' && app !== 'engine' && app !== 'plugin' && app !== 'sandboxed')
    throw new Error(usage);
  if (!out) throw new Error(usage);
  if (app === 'plugin') return pluginSecrets(out, id, more);
  if (app === 'sandboxed') return sandboxedSecrets(out, id);
  const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
  if (missing.length)
    throw new Error(
      `${missing.join(', ')} not set: add it to the deployment's GitHub environment (scripts/provision.sh generates one)`,
    );
  const short = keysProblem(process.env);
  if (short) throw new Error(short);
  const problem = app === 'engine' && id ? secretsProblem(byId(id), process.env) : null;
  if (problem) throw new Error(problem);
  // Only the ones set: `--secrets-file` adds to a Worker's secrets and never removes one.
  const values = Object.fromEntries(
    SECRETS[app].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`${app}: ${Object.keys(values).join(', ') || 'no secrets set'}`);
}

/** Names a plugin's env already has from the deployment (`RESERVED_PLUGIN_ENV` in @orderloop/core). */
const PLUGIN_RESERVED_ENV = new Set([
  'PLUGIN_KEY',
  'PLUGIN_KEY_PREVIOUS',
  'DB',
  'SECRETS',
  'STORAGE',
]);

/**
 * A plugin's own secrets among the deployment's: each `PLUGIN_<ID>_<NAME>` (`pluginSecretVar` in
 * @orderloop/core), under `<NAME>`. Nothing without the plugin's prefix reaches it.
 */
export function pluginOwnSecrets(plugin: string, source: Record<string, unknown>) {
  const prefix = `${pluginBinding(plugin)}_`;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!k.startsWith(prefix) || typeof v !== 'string' || !v) continue;
    const name = k.slice(prefix.length);
    if (!/^[A-Z][A-Z0-9_]{0,62}$/.test(name) || PLUGIN_RESERVED_ENV.has(name))
      throw new Error(`${k}: ${name} can't be a secret name for plugin ${plugin}`);
    values[name] = v;
  }
  return values;
}

/**
 * Sandboxed plugins' secrets, added to the engine's secrets file as PLUGIN_SECRETS (`{ "<id>":
 * { "<NAME>": "…" } }`, each from the environment's PLUGIN_<ID>_* by `pluginOwnSecrets`). A
 * deployment with a Secrets Store reads them from it instead, so nothing is written for it.
 */
function sandboxedSecrets(out: string, id: string | undefined) {
  const d = byId(id);
  const plugins = sandboxedPlugins(d);
  if (!plugins.length || d.secretsStore) {
    console.log(`sandboxed: ${d.secretsStore ? 'secrets come from the Secrets Store' : 'none'}`);
    return;
  }
  const all = process.env.ENV_SECRETS ? JSON.parse(process.env.ENV_SECRETS) : process.env;
  const values = Object.fromEntries(plugins.map((p) => [p, pluginOwnSecrets(p, all)]));
  const file = existsSync(out)
    ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>)
    : {};
  writeFileSync(out, JSON.stringify({ ...file, PLUGIN_SECRETS: JSON.stringify(values) }), {
    mode: 0o600,
  });
  console.log(
    `sandboxed: ${plugins.map((p) => `${p} (${Object.keys(values[p]!).join(', ') || 'no secrets'})`).join('; ')}`,
  );
}

/**
 * The secrets a plugin's manifest needs (`required`, its non-optional names) that the deployment
 * doesn't have: from the environment (PLUGIN_<ID>_<NAME>, shared account), or for a deployment
 * with a Secrets Store, missing from its registry entry's `secrets` or from `stored` (the store's
 * secret names). Presence only: no value is read.
 */
export function missingPluginSecrets(
  d: Deployment,
  p: string,
  required: string[],
  source: { env?: Record<string, unknown>; stored?: string[] },
): string[] {
  if (d.secretsStore) {
    const listed = new Set(d.plugins[p]?.secrets ?? []);
    const stored = new Set(source.stored ?? []);
    return required.filter((n) => !listed.has(n) || !stored.has(pluginSecretVar(p, n)));
  }
  const env = source.env ?? {};
  return required.filter((n) => {
    const v = env[pluginSecretVar(p, n)];
    return typeof v !== 'string' || !v;
  });
}

/**
 * CI's check, before anything deploys: every secret the plugin's manifest (as `scripts/plugin-
 * bundle.ts` extracted it) needs is set. With a Secrets Store, STORE_SECRET_NAMES is the JSON list
 * of the store's secret names; else ENV_SECRETS (the job's secrets) or the environment is checked.
 */
function checkPluginSecrets(id: string | undefined, plugin: string | undefined, manifest?: string) {
  if (!plugin || !manifest) throw new Error('check-plugin-secrets <id> <plugin> <manifest.json>');
  const d = byId(id);
  if (!(plugin in d.plugins)) throw new Error(`${d.id} doesn't install plugin ${plugin}`);
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as {
    id: string;
    secrets: { name: string; optional?: boolean }[];
  };
  if (m.id !== plugin)
    throw new Error(`${manifest}: the manifest's id is "${m.id}", not "${plugin}"`);
  const required = m.secrets.filter((s) => !s.optional).map((s) => s.name);
  const missing = missingPluginSecrets(d, plugin, required, {
    env: process.env.ENV_SECRETS ? JSON.parse(process.env.ENV_SECRETS) : process.env,
    stored: process.env.STORE_SECRET_NAMES ? JSON.parse(process.env.STORE_SECRET_NAMES) : [],
  });
  if (missing.length)
    throw new Error(
      d.secretsStore
        ? `${d.id}: plugin ${plugin} needs ${missing.map((n) => pluginSecretVar(plugin, n)).join(', ')}: list them under plugins.${plugin}.secrets and add them to the Secrets Store`
        : `${d.id}: plugin ${plugin} needs ${missing.map((n) => pluginSecretVar(plugin, n)).join(', ')} in the ${d.environment} GitHub environment`,
    );
  console.log(`${plugin}: ${required.length ? required.join(', ') : 'no required secrets'} set`);
}

/**
 * A plugin's secrets: its own keys derived from PRINCIPAL_KEY (and the one before a rotation), and
 * its PLUGIN_<ID>_* secrets from ENV_SECRETS (the job's `toJSON(secrets)`), else the environment.
 */
function pluginSecrets(out: string, plugin: string | undefined, id?: string) {
  if (!plugin || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(plugin))
    throw new Error('secrets plugin <out> <plugin id> [deployment id]');
  // With a Secrets Store its own secrets are bound from the store (renderPlugin), not written here.
  const fromStore = id ? !!byId(id).secretsStore : false;
  const current = process.env.PRINCIPAL_KEY;
  if (!current) throw new Error("PRINCIPAL_KEY not set: a plugin's key is derived from it");
  const previous = process.env.PRINCIPAL_KEY_PREVIOUS;
  const all = process.env.ENV_SECRETS ? JSON.parse(process.env.ENV_SECRETS) : process.env;
  const values = {
    ...(fromStore ? {} : pluginOwnSecrets(plugin, all)),
    PLUGIN_KEY: pluginKey(current, plugin),
    ...(previous ? { PLUGIN_KEY_PREVIOUS: pluginKey(previous, plugin) } : {}),
  };
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`plugin ${plugin}: ${Object.keys(values).join(', ')}`);
}

function shellNames(id: string | undefined) {
  const d = byId(id);
  const n = names(d);
  const vars = {
    WEB: n.web,
    D1: n.d1,
    R2: n.r2,
    AI_GATEWAY: n.aiGateway,
    CATALOG_R2: n.catalogR2,
    CATALOG_KV: n.catalogKv,
    CATALOG_FEED_PARTS: n.catalogFeedParts,
    CATALOG_FEED_PARTS_DLQ: n.catalogFeedPartsDlq,
    CATALOG_PURGE: n.catalogPurge,
    CATALOG_PURGE_DLQ: n.catalogPurgeDlq,
    CATALOG_CHANGES: n.catalogChanges,
    CATALOG_CHANGES_DLQ: n.catalogChangesDlq,
    CATALOG_DOMAIN: d.catalogDomain,
    DOMAIN: d.domain,
    ENVIRONMENT: d.environment,
    JURISDICTION: d.jurisdiction ?? '',
    AI_GATEWAY_LOGS: String(d.aiGatewayLogs),
    AUDIT_ARCHIVE_DAYS: String(d.auditArchiveDays ?? ''),
    // Space-separated plugin ids; each one's D1 database is named orderloop-plugin-<id><suffix>.
    PLUGINS: workerPlugins(d).join(' '),
    // The deployment's own Secrets Store (own Cloudflare account), when its registry names one.
    SECRETS_STORE: d.secretsStore?.storeId ?? '',
    // Plugins the engine loads from a bundle: no Worker or D1 to create.
    SANDBOXED_PLUGINS: sandboxedPlugins(d).join(' '),
    SUFFIX: d.suffix,
  };
  for (const [k, v] of Object.entries(vars)) console.log(`${k}='${v}'`);
}

/** Writes one field into deployments/<id>.jsonc, keeping its comments. */
function setField(id: string | undefined, field: 'd1Id' | 'catalogKvId', value: string) {
  const d = byId(id);
  const file = join(ROOT, 'deployments', `${d.id}.jsonc`);
  const text = readFileSync(file, 'utf8');
  const edits = modify(text, [field], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

function setPluginD1(id: string | undefined, plugin: string | undefined, uuid: string | undefined) {
  if (!plugin || !uuid || !/^[0-9a-f-]{36}$/.test(uuid))
    throw new Error('set-plugin-d1 <id> <plugin> <uuid>');
  const d = byId(id);
  if (!(plugin in d.plugins)) throw new Error(`${d.id} doesn't install plugin ${plugin}`);
  const file = join(ROOT, 'deployments', `${d.id}.jsonc`);
  const text = readFileSync(file, 'utf8');
  const edits = modify(text, ['plugins', plugin, 'd1Id'], uuid, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

function setD1(id: string | undefined, uuid: string | undefined) {
  if (!uuid || !/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('set-d1 <id> <uuid>');
  setField(id, 'd1Id', uuid);
}

function setCatalogKv(id: string | undefined, kvId: string | undefined) {
  if (!kvId || !/^[0-9a-f]{32}$/.test(kvId)) throw new Error('set-catalog-kv <id> <namespace id>');
  setField(id, 'catalogKvId', kvId);
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
    else if (cmd === 'secrets') secrets(args[0], args[1], args[2], args[3]);
    else if (cmd === 'check-plugin-secrets') checkPluginSecrets(args[0], args[1], args[2]);
    else if (cmd === 'status') await status();
    else if (cmd === 'names') shellNames(args[0]);
    else if (cmd === 'set-d1') setD1(args[0], args[1]);
    else if (cmd === 'set-catalog-kv') setCatalogKv(args[0], args[1]);
    else if (cmd === 'set-plugin-d1') setPluginD1(args[0], args[1], args[2]);
    else if (cmd === 'demos')
      console.log(JSON.stringify(loadDeployments().filter((d) => d.demo && d.d1Id)));
    else
      throw new Error(
        'usage: fleet.ts render|matrix|secrets|check-plugin-secrets|status|names|set-d1|set-catalog-kv|set-plugin-d1|demos (see the header)',
      );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
