/**
 * Runtime installs: an admin installs a sandboxed plugin from a signed bundle (`.olplugin`, made by
 * `pnpm plugin:pack`) without a deploy. Only a publisher the deployment's registry lists
 * (`PLUGIN_PUBLISHERS`) is trusted. An upload is checked and stored `pending`; the admin reviews
 * what it asks for and approves it (the web app has them pass a step-up check first), enters its
 * secrets (sealed with DATA_KEY, never shown again), and can disable, roll back or uninstall it.
 * Once active it runs exactly as a CI-pinned sandboxed plugin (plugin-host.ts). The web app has
 * authorized the caller (an admin) before any call here; `by` is who, for the rows. See
 * docs/plugins.md, "Installing at runtime".
 *
 * A plugin the assistant drafts (assistant/plugin-draft.ts) is staged the same way, under the
 * publisher `assistant`, which the deployment trusts only with `ASSISTANT_PLUGINS` on; it carries
 * test cases that must all pass before it can be approved.
 */

import { WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers';
import {
  ASSISTANT_PUBLISHER,
  boundText,
  PLUGIN_BUNDLE_MAX_BYTES,
  type PluginCase,
  type PluginCaseResult,
  type PluginInstallStatus,
  type PluginInstallView,
  type PluginManifest,
  type PluginRpc,
  parseManifest,
  pluginBundleFileSchema,
  pluginCasesSchema,
  type Refusable,
  secretContext,
  verifyBundleSignature,
} from '@orderloop/core';
import { createDb, installedPlugins, pluginSecrets } from '@orderloop/db';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { sealSecret } from './data-key';
import { pluginStorage } from './namespaces';
import { runCases } from './plugin-cases';
import {
  dropInstallsCache,
  knownManifests,
  registryOwns,
  resolveSecret,
  verifiedBundle,
} from './plugin-host';
import { pluginUsage } from './plugins';

/** An install refused for a reason the admin can act on; its message is shown as it is. */
export class InstallRefused extends Error {}

/** An install call as the RPC answers it: a refusal is a value, so its message reaches the admin. */
export async function refusable<T>(run: () => Promise<T>): Promise<Refusable<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof InstallRefused) return { ok: false, error: err.message };
    throw err;
  }
}

/** The longest secret value an admin may enter. */
const SECRET_MAX = 4096;

/** Test fixtures (as in scripts/fleet.ts): no deployment installs them, at runtime either. */
const FIXTURE_IDS = new Set(['example', 'fixture-carrier']);

/** What a bundle's `migrations` must be (`PluginStorage` applies them in order, by name). */
const isMigrations = (v: unknown): v is { name: string; sql: string }[] =>
  Array.isArray(v) &&
  v.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as { name?: unknown }).name === 'string' &&
      typeof (m as { sql?: unknown }).sql === 'string',
  );

const db = (env: Env) => createDb(env.DB);

/** The publishers this deployment trusts, by name; empty when runtime installs are off. */
function publishers(env: Env): Record<string, string> {
  const raw = (env as unknown as { PLUGIN_PUBLISHERS?: string }).PLUGIN_PUBLISHERS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    console.error('PLUGIN_PUBLISHERS is not JSON; runtime installs are off');
    return {};
  }
}

/** Whether this deployment lets the assistant draft plugins (`pluginInstalls.assistant`). */
export const assistantDrafts = (env: Env) =>
  (env as unknown as { ASSISTANT_PLUGINS?: string }).ASSISTANT_PLUGINS === 'on';

/** Whether versions signed by (or drafted as) `publisher` may start running. */
const trusted = (env: Env, publisher: string) =>
  publisher === ASSISTANT_PUBLISHER ? assistantDrafts(env) : !!publishers(env)[publisher];

const notTrusted = (row: Row) =>
  row.publisher === ASSISTANT_PUBLISHER
    ? `${row.id} ${row.version} was drafted by the assistant, which this deployment no longer allows`
    : `${row.publisher}, who signed ${row.id} ${row.version}, is no longer trusted`;

export const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

type Row = typeof installedPlugins.$inferSelect;

async function view(env: Env, row: Row): Promise<PluginInstallView> {
  const manifest = parseManifest(JSON.parse(row.manifest));
  const secrets = await Promise.all(
    manifest.secrets.map(async (s) => ({
      name: s.name,
      set: (await resolveSecret(env, row.id, s.name)) !== undefined,
    })),
  );
  return {
    id: row.id,
    sha: row.sha,
    version: row.version,
    publisher: row.publisher,
    status: row.status as PluginInstallStatus,
    personalDataGranted: row.personalDataGranted === 1,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    manifest,
    secrets,
    request: row.request,
    cases: row.cases ? (JSON.parse(row.cases) as PluginCaseResult[]) : null,
    code: row.publisher === ASSISTANT_PUBLISHER ? await draftRules(env, row) : null,
  };
}

/** An assistant draft's rule code, as the model wrote it (the bundle keeps it as `rules`). */
async function draftRules(env: Env, row: Row): Promise<string | null> {
  try {
    const bundle = (await verifiedBundle(env, row.id, row.sha)) as { rules?: unknown };
    return typeof bundle.rules === 'string' ? bundle.rules : null;
  } catch {
    return null;
  }
}

const rowsOf = (env: Env, id: string) =>
  db(env).select().from(installedPlugins).where(eq(installedPlugins.id, id));

/** The row of an id that runs or would run (active, else disabled). */
const current = (rows: Row[]) =>
  rows.find((r) => r.status === 'active') ?? rows.find((r) => r.status === 'disabled');

/**
 * A dry run: the bundle loaded with nothing (no network, no storage, no secrets), asked for its
 * manifest, which must be the one sealed in it. A plugin whose code answers otherwise never
 * installs.
 */
async function dryRun(env: Env, id: string, sha: string, code: string, sealed: PluginManifest) {
  const caps = workerExports as unknown as Record<string, (o: { props: object }) => unknown>;
  const worker = env.LOADER.load({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js',
    modules: { 'index.js': code },
    env: { __ORDERLOOP_SANDBOX: true, SECRETS: caps.DryRunSecrets!({ props: {} }) },
    globalOutbound: null,
  } as unknown as WorkerLoaderWorkerCode);
  const stub = worker.getEntrypoint(undefined, {
    limits: { cpuMs: 1000, subRequests: 0 },
  }) as unknown as PluginRpc;
  let answered: PluginManifest;
  try {
    answered = parseManifest(await stub.manifest());
  } catch (err) {
    // The publisher's text: one line, and short, for the page and the audit log.
    const said = boundText(err instanceof Error ? err.message : String(err), 300) ?? 'no reason';
    throw new InstallRefused(`${id} (${sha.slice(0, 12)}) didn't load: ${said}`);
  }
  if (JSON.stringify(answered) !== JSON.stringify(sealed))
    throw new InstallRefused(
      `${id}'s code answers with another manifest than the one it was signed with`,
    );
}

/**
 * Checks a signed bundle and stores it `pending`: who signed it (a listed publisher, and a valid
 * signature over its id, version and hash), that the body is what was signed, that its manifest
 * is for that id and version, that the deployment doesn't pin or bind that id itself, that an
 * upgrade comes from the publisher already installed, and that it loads and answers with its
 * sealed manifest.
 */
export async function uploadPlugin(env: Env, text: string, by: string): Promise<PluginInstallView> {
  if (new TextEncoder().encode(text).byteLength > PLUGIN_BUNDLE_MAX_BYTES)
    throw new InstallRefused(
      `A plugin bundle is at most ${PLUGIN_BUNDLE_MAX_BYTES / 1024 / 1024} MiB`,
    );
  const keys = publishers(env);
  if (!Object.keys(keys).length)
    throw new InstallRefused('Runtime installs are off for this deployment');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InstallRefused('That is not a plugin bundle (.olplugin)');
  }
  const parsed = pluginBundleFileSchema.safeParse(raw);
  if (!parsed.success) throw new InstallRefused('That is not a plugin bundle (.olplugin)');
  const file = parsed.data;
  if (file.publisher === ASSISTANT_PUBLISHER)
    throw new InstallRefused('Only the assistant drafts plugins as “assistant”');
  const key = keys[file.publisher];
  if (!key)
    throw new InstallRefused(`“${file.publisher}” is not a publisher this deployment trusts`);
  if (!(await verifyBundleSignature(key, file)))
    throw new InstallRefused(`The signature isn't ${file.publisher}'s`);
  if ((await sha256(file.body)) !== file.sha)
    throw new InstallRefused('The bundle is not what was signed');
  let bundle: { code: string; migrations: unknown; manifest: unknown };
  let manifest: PluginManifest;
  try {
    bundle = JSON.parse(file.body);
    manifest = parseManifest(bundle.manifest);
  } catch (err) {
    throw new InstallRefused(err instanceof Error ? err.message : 'The bundle is malformed');
  }
  if (manifest.id !== file.id || manifest.version !== file.version)
    throw new InstallRefused(
      `The bundle is ${manifest.id} ${manifest.version}, signed as ${file.id} ${file.version}`,
    );
  return stageBundle(env, { sha: file.sha, body: file.body, bundle, manifest }, file.publisher, by);
}

/**
 * Stores a checked bundle `pending`, for an admin to review: an upload's (signed), or a draft the
 * assistant wrote for `request`, with its cases' results. Refused for an id the registry installs,
 * a test fixture, malformed migrations, another publisher's id, a version already uploaded, or
 * code that doesn't answer with its sealed manifest.
 */
export async function stageBundle(
  env: Env,
  staged: {
    sha: string;
    body: string;
    bundle: { code: string; migrations: unknown };
    manifest: PluginManifest;
  },
  publisher: string,
  by: string,
  draft?: { request: string; cases: PluginCaseResult[] },
): Promise<PluginInstallView> {
  const { sha, body, bundle, manifest } = staged;
  const file = { id: manifest.id, version: manifest.version, sha, publisher };
  if (!isMigrations(bundle.migrations))
    throw new InstallRefused('The bundle’s migrations are malformed');
  if (
    FIXTURE_IDS.has(file.id) &&
    !(env as unknown as { PLUGIN_TEST_FIXTURES?: string }).PLUGIN_TEST_FIXTURES
  )
    throw new InstallRefused(`${file.id} is a test fixture, never installed`);
  if (registryOwns(env, file.id))
    throw new InstallRefused(`${file.id} is installed by this deployment's registry`);
  const rows = await rowsOf(env, file.id);
  const installed = rows.filter((r) => r.status !== 'uninstalled');
  if (installed.some((r) => r.publisher !== file.publisher))
    throw new InstallRefused(
      file.publisher === ASSISTANT_PUBLISHER
        ? `${file.id} is installed from a file: the assistant only revises plugins it drafted`
        : `${file.id} is installed from another publisher: uninstall it before installing this one`,
    );
  const same = installed.find((r) => r.sha === file.sha);
  // Uploading the same file again (a retry) answers with the review it got the first time.
  if (same?.status === 'pending') return view(env, same);
  if (same) throw new InstallRefused(`${file.id} ${file.version} is already uploaded`);
  // A version names one bundle, ever (`installed_plugins_version`).
  if (rows.some((r) => r.version === file.version && r.sha !== file.sha))
    throw new InstallRefused(
      `${file.id} ${file.version} was uploaded before with other contents: give this one a new version`,
    );
  await dryRun(env, file.id, file.sha, bundle.code, manifest);
  // Its first install (or the first since an uninstall): whatever the id stored before, under a
  // registry plugin of that id since removed, or an earlier install, is gone.
  if (!installed.length) await pluginStorage(env, file.id).destroy();
  await env.DOCS.put(`plugins/${file.id}/${file.sha}.json`, body, {
    httpMetadata: { contentType: 'application/json' },
  });
  const row: Row = {
    id: file.id,
    sha: file.sha,
    version: file.version,
    publisher: file.publisher,
    manifest: JSON.stringify(manifest),
    status: 'pending',
    personalDataGranted: 0,
    uploadedBy: by,
    uploadedAt: Date.now(),
    approvedBy: null,
    approvedAt: null,
    request: draft?.request ?? null,
    cases: draft ? JSON.stringify(draft.cases) : null,
  };
  const insert = db(env)
    .insert(installedPlugins)
    .values(row)
    // Only an uninstalled row of the same file is replaced, and wholly: never one that runs.
    .onConflictDoUpdate({
      target: [installedPlugins.id, installedPlugins.sha],
      set: {
        publisher: row.publisher,
        status: 'pending',
        personalDataGranted: 0,
        uploadedBy: by,
        uploadedAt: row.uploadedAt,
        approvedBy: null,
        approvedAt: null,
        request: row.request,
        cases: row.cases,
      },
      setWhere: eq(installedPlugins.status, 'uninstalled'),
    });
  try {
    await insert;
  } catch (err) {
    // Two drafts (or uploads) of one version at once: `installed_plugins_version` lets one in.
    if (String(err).includes('UNIQUE')) throw new InstallRefused(changedMeanwhile(file.id));
    throw err;
  }
  return view(env, row);
}

/** An uploaded version, to run: refused once its publisher is no longer trusted. */
async function find(env: Env, id: string, sha: string) {
  const rows = await rowsOf(env, id);
  const row = rows.find((r) => r.sha === sha);
  if (!row) throw new InstallRefused(`${id} (${sha.slice(0, 12)}) is not uploaded`);
  if (!trusted(env, row.publisher)) throw new InstallRefused(notTrusted(row));
  return { row, rows };
}

/**
 * Makes `row` the one that runs, if it is still `from` (pending, or superseded for a rollback); the
 * one running before it is superseded. One batch, so it is all or nothing, and each statement
 * guards on the status it expects, so two admins acting at once can't leave two running (the
 * `installed_plugins_running` index is the backstop).
 */
async function activate(env: Env, row: Row, from: PluginInstallStatus, set: Partial<Row>) {
  const d = db(env);
  const still = sql`exists (select 1 from installed_plugins t where t.id = ${row.id} and t.sha = ${row.sha} and t.status = ${from})`;
  const [, activated] = await d.batch([
    d
      .update(installedPlugins)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(installedPlugins.id, row.id),
          ne(installedPlugins.sha, row.sha),
          inArray(installedPlugins.status, ['active', 'disabled']),
          still,
        ),
      ),
    d
      .update(installedPlugins)
      .set({ ...set, status: 'active' })
      .where(
        and(
          eq(installedPlugins.id, row.id),
          eq(installedPlugins.sha, row.sha),
          eq(installedPlugins.status, from),
        ),
      ),
  ]);
  dropInstallsCache();
  knownManifests.delete(row.id);
  if (!changed(activated)) throw new InstallRefused(changedMeanwhile(row.id));
}

const changed = (r: unknown) => ((r as D1Result).meta?.changes ?? 0) > 0;
const changedMeanwhile = (id: string) =>
  `${id} changed while you were looking: reload and try again`;

/**
 * Approves a pending upload: it runs from now on, the version before it superseded. Every secret
 * it needs must be set first, and a plugin that asks for buyer details runs only if granted them.
 */
export async function approvePlugin(
  env: Env,
  id: string,
  sha: string,
  grant: { personalData: boolean },
  by: string,
) {
  const { row } = await find(env, id, sha);
  if (row.status !== 'pending') throw new InstallRefused(`${id} ${row.version} is ${row.status}`);
  const v = await view(env, row);
  const missing = v.manifest.secrets
    .filter((s) => !s.optional && !v.secrets.find((x) => x.name === s.name)?.set)
    .map((s) => s.name);
  if (missing.length) throw new InstallRefused(`Set ${missing.join(', ')} before approving`);
  if (v.manifest.personalData === 'send' && !grant.personalData)
    throw new InstallRefused(`${id} needs buyer details: grant them, or don't install it`);
  // A draft runs only once it has a case for every step and they all pass, run again now on the
  // bundle that would run.
  if (row.publisher === ASSISTANT_PUBLISHER) {
    const results = await rerun(env, row, v.cases ?? []);
    const failing = results.filter((c) => !c.pass).length;
    const untested = v.manifest.nodes.filter(
      (n) => !results.some((c) => `${id}.${c.node}` === n.type),
    );
    if (untested.length)
      throw new InstallRefused(
        `Add a test case for ${untested.map((n) => n.label).join(', ')} before approving`,
      );
    if (failing)
      throw new InstallRefused(`${failing} of ${results.length} cases fail: fix ${id} first`);
  }
  const personalData = v.manifest.personalData === 'send' && grant.personalData;
  await activate(env, row, 'pending', {
    approvedBy: by,
    approvedAt: Date.now(),
    personalDataGranted: personalData ? 1 : 0,
  });
  return { id, version: row.version, sha, personalData };
}

/** Sets (or replaces) a secret a plugin declares; it is sealed, and never read back out. */
export async function setPluginSecret(
  env: Env,
  id: string,
  name: string,
  value: string,
  by: string,
) {
  const rows = (await rowsOf(env, id)).filter((r) => r.status !== 'uninstalled');
  const latest = current(rows) ?? rows.find((r) => r.status === 'pending');
  if (!latest) throw new InstallRefused(`${id} is not installed at runtime`);
  const declared = rows.some((r) =>
    parseManifest(JSON.parse(r.manifest)).secrets.some((s) => s.name === name),
  );
  if (!declared) throw new InstallRefused(`${id} doesn't declare a secret named ${name}`);
  if (!value || value.length > SECRET_MAX)
    throw new InstallRefused(`A secret is 1 to ${SECRET_MAX} characters`);
  const sealed = await sealSecret(env, value, secretContext.plugin(id, name));
  const now = Date.now();
  await db(env)
    .insert(pluginSecrets)
    .values({ pluginId: id, name, value: sealed, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({
      target: [pluginSecrets.pluginId, pluginSecrets.name],
      set: { value: sealed, updatedBy: by, updatedAt: now },
    });
  return { id, name };
}

/** Stops (or restarts) a runtime-installed plugin: disabled, its nodes read as not installed. */
export async function setPluginEnabled(env: Env, id: string, enabled: boolean) {
  const rows = await rowsOf(env, id);
  const row = current(rows);
  if (!row) throw new InstallRefused(`${id} is not installed at runtime`);
  const to = enabled ? 'active' : 'disabled';
  if (row.status === to) return { id, status: to };
  if (enabled && !trusted(env, row.publisher)) throw new InstallRefused(notTrusted(row));
  const r = await db(env)
    .update(installedPlugins)
    .set({ status: to })
    .where(
      and(
        eq(installedPlugins.id, id),
        eq(installedPlugins.sha, row.sha),
        eq(installedPlugins.status, row.status),
      ),
    );
  dropInstallsCache();
  if (!changed(r)) throw new InstallRefused(changedMeanwhile(id));
  return { id, version: row.version, status: to };
}

/** Runs an earlier version again (its bundle is kept); the current one is superseded. */
export async function rollbackPlugin(env: Env, id: string, sha: string) {
  const { row } = await find(env, id, sha);
  if (row.status !== 'superseded')
    throw new InstallRefused(
      `${id} ${row.version} is ${row.status}: only an earlier version can be rolled back to`,
    );
  await activate(env, row, 'superseded', {});
  return { id, version: row.version, sha };
}

/**
 * Uninstalls a runtime-installed plugin, once nothing uses it (`pluginUsage`): its rows are kept as
 * `uninstalled` for the record, its secrets and its storage deleted. Its bundles stay in R2. The
 * storage goes first, so a failure leaves it installed and the uninstall can be retried. Other
 * isolates may run it for up to their cache's 15 seconds after; a later install of the id wipes
 * whatever that wrote. A flow published in the moment between the usage check and the uninstall
 * fails at the plugin's node, as one using any removed plugin does.
 */
export async function uninstallPlugin(env: Env, id: string) {
  const rows = (await rowsOf(env, id)).filter((r) => r.status !== 'uninstalled');
  if (!rows.length) throw new InstallRefused(`${id} is not installed at runtime`);
  const usage = await pluginUsage(env, id);
  if (usage.flows.length || usage.orders.length || usage.labels.length)
    throw new InstallRefused(
      `${id} is still in use: ${usage.flows.length} published flows, ${usage.orders.length} running orders, ${usage.labels.length} labels not voided`,
    );
  await pluginStorage(env, id).destroy();
  const d = db(env);
  await d.batch([
    d.update(installedPlugins).set({ status: 'uninstalled' }).where(eq(installedPlugins.id, id)),
    d.delete(pluginSecrets).where(eq(pluginSecrets.pluginId, id)),
  ]);
  dropInstallsCache();
  knownManifests.delete(id);
  return { id };
}

/**
 * Runs `cases` on a stored draft's bundle and keeps them, with their results, on its row, if no one
 * changed its cases since `row` was read (else an admin's edit would be lost, or approved unseen).
 */
async function rerun(env: Env, row: Row, cases: PluginCase[]): Promise<PluginCaseResult[]> {
  const parsed = pluginCasesSchema.safeParse(cases);
  if (!parsed.success)
    throw new InstallRefused(
      `Those cases don't read: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`,
    );
  const bundle = await verifiedBundle(env, row.id, row.sha);
  const results = await runCases(env, bundle.code, bundle.manifest, parsed.data);
  const r = await db(env)
    .update(installedPlugins)
    .set({ cases: JSON.stringify(results) })
    .where(
      and(
        eq(installedPlugins.id, row.id),
        eq(installedPlugins.sha, row.sha),
        row.cases === null ? isNull(installedPlugins.cases) : eq(installedPlugins.cases, row.cases),
      ),
    );
  if (!changed(r)) throw new InstallRefused(changedMeanwhile(row.id));
  return results;
}

/**
 * Saves an assistant draft's test cases, as an admin edited them, and runs them. Only a draft under
 * review: once approved, a change is a new draft.
 */
export async function runPluginCases(
  env: Env,
  id: string,
  sha: string,
  cases: PluginCase[],
): Promise<PluginCaseResult[]> {
  const { row } = await find(env, id, sha);
  if (row.publisher !== ASSISTANT_PUBLISHER)
    throw new InstallRefused(`${id} was uploaded from a file: it has no test cases`);
  if (row.status !== 'pending')
    throw new InstallRefused(
      `${id} ${row.version} is ${row.status}: ask the assistant to revise it`,
    );
  return rerun(env, row, cases);
}

/** Every runtime install, newest first, without a secret's value. */
export async function listPluginInstalls(env: Env): Promise<PluginInstallView[]> {
  const rows = await db(env).select().from(installedPlugins);
  rows.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return Promise.all(rows.map((r) => view(env, r)));
}

/**
 * The dry run's `SECRETS`: every secret reads as set (so the plugin's manifest call doesn't fail
 * on one the admin hasn't entered yet), and none has a value.
 */
export class DryRunSecrets extends WorkerEntrypoint<Env> {
  async has() {
    return true;
  }

  async get() {
    return null;
  }
}
