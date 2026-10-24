/**
 * Agentic checkout over UCP, the web Worker's part: the platforms an admin lets in, the checkout
 * flow, and forwarding `/ucp/*` to the engine (apps/engine/src/ucp/).
 *
 * A platform calls with its API key (`X-API-Key`, or `Authorization: Bearer`) and names its UCP
 * profile in `UCP-Agent`, which must be the profile it was registered with. The key stays here:
 * the engine gets the platform in the signed principal header (`signPlatform`), never a key.
 * Discovery (`/.well-known/ucp`) is public and comes from the engine, which holds the signing key.
 */

import { env } from 'cloudflare:workers';
import {
  checkoutFlowProblem,
  DEV_PRINCIPAL_KEY,
  type FlowGraph,
  newId,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  readUcpSettings,
  signPlatform,
  UCP_MCP_PATH,
  UCP_PATH,
  UCP_PLATFORM_KEY_PREFIX,
  UCP_SETTINGS_KEY,
  type UcpSettings,
  ucpAgentProfile,
  ucpError,
} from '@orderloop/core';
import { getFlowVersionJson, ucpPlatforms, workspaceSettings } from '@orderloop/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { platformInput } from './api-schemas';
import { randomToken, sha256Hex } from './credentials';
import { afterResponse, db, engine } from './env.server';
import { overBudget } from './rate-limit';

type Row = typeof ucpPlatforms.$inferSelect;

/** What the API shows: never the key. */
const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  profileUrl: r.profileUrl,
  keyPrefix: r.keyPrefix,
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
});

export async function listPlatforms() {
  const rows = await db()
    .select()
    .from(ucpPlatforms)
    .orderBy(desc(ucpPlatforms.createdAt))
    .limit(500);
  return rows.map(view);
}

/** The key is returned once, here; afterwards only the platform holds it. */
export async function addPlatform(input: z.infer<typeof platformInput>, by: string) {
  const key = `${UCP_PLATFORM_KEY_PREFIX}${randomToken()}`;
  const [row] = await db()
    .insert(ucpPlatforms)
    .values({
      id: newId('ucp'),
      name: input.name,
      profileUrl: input.profileUrl,
      keyPrefix: key.slice(0, UCP_PLATFORM_KEY_PREFIX.length + 4),
      keyHash: await sha256Hex(key),
      createdAt: Date.now(),
      createdBy: by,
    })
    .returning();
  return { platform: view(row!), key };
}

/** Revoked at once. The row stays, so its checkouts and orders still name it. */
export async function revokePlatform(id: string) {
  const res = await db()
    .update(ucpPlatforms)
    .set({ revokedAt: Date.now() })
    .where(and(eq(ucpPlatforms.id, id), isNull(ucpPlatforms.revokedAt)))
    .returning();
  return res[0] ? view(res[0]) : null;
}

const SETTINGS_CACHE_MS = 30_000;
let cachedSettings: { value: UcpSettings; at: number } | null = null;

/**
 * Agentic checkout's settings; off (no checkout flow) until an admin sets them. Every `/ucp`
 * call checks them and they change rarely, so each isolate keeps what it read for 30 seconds.
 * `fresh` reads D1 regardless, for the admin API: what an admin sees or changes is never a
 * copy another isolate read before their last save.
 */
export async function ucpSettings({ fresh = false } = {}): Promise<UcpSettings> {
  if (!fresh && cachedSettings && Date.now() - cachedSettings.at < SETTINGS_CACHE_MS)
    return cachedSettings.value;
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, UCP_SETTINGS_KEY))
    .get();
  const value = readUcpSettings(row?.value);
  cachedSettings = { value, at: Date.now() };
  return value;
}
export const forgetUcpSettings = () => {
  cachedSettings = null;
};

/** Why `flowId` can't take checkouts (unknown, unpublished, or never holds a card), or null. */
export async function checkoutFlowRefusal(flowId: string): Promise<string | null> {
  const row = await getFlowVersionJson(db(), flowId);
  if (!row) return `No published flow ${flowId}`;
  return checkoutFlowProblem(row.flow as unknown as FlowGraph);
}

export async function setUcpSettings(next: UcpSettings, by: string) {
  const now = Date.now();
  const value = JSON.stringify(next);
  await db()
    .insert(workspaceSettings)
    .values({ key: UCP_SETTINGS_KEY, value, updatedAt: now, updatedBy: by })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: now, updatedBy: by },
    });
  cachedSettings = { value: next, at: now };
}

/** How often a platform's last use is written back. */
const TOUCH_MS = 5 * 60_000;

/** The platform behind a request's key, if the key is live. */
async function platformFor(request: Request): Promise<Row | null> {
  const key =
    request.headers.get('x-api-key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!key.startsWith(UCP_PLATFORM_KEY_PREFIX)) return null;
  const row = await db()
    .select()
    .from(ucpPlatforms)
    .where(and(eq(ucpPlatforms.keyHash, await sha256Hex(key)), isNull(ucpPlatforms.revokedAt)))
    .get();
  if (!row) return null;
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt > TOUCH_MS)
    afterResponse(
      db().update(ucpPlatforms).set({ lastUsedAt: now }).where(eq(ucpPlatforms.id, row.id)),
    );
  return row;
}

const refuse = (status: number, code: string, content: string, headers?: HeadersInit) =>
  Response.json(ucpError(code, content), { status, headers });

/**
 * Forwards a `/ucp/*` request from a registered platform to the engine, or refuses it: 401
 * without a live key, 400 without a profile in `UCP-Agent` (REST), 403 when it names a profile
 * other than the platform's, 404 while agentic checkout is off.
 */
export async function ucpFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const row = await platformFor(request);
  if (!row)
    return refuse(401, 'unauthorized', 'Send your API key in X-API-Key.', {
      'www-authenticate': 'Bearer',
    });
  // REST names the profile in UCP-Agent; MCP may name it only in each call's meta, which the
  // engine checks against the same registered profile.
  const header = request.headers.get('ucp-agent');
  const profile = ucpAgentProfile(header);
  if (!profile && (header || url.pathname !== UCP_MCP_PATH))
    return refuse(
      400,
      'invalid_profile_url',
      'Name your profile in UCP-Agent: profile="https://…".',
    );
  if (profile && profile !== row.profileUrl)
    return refuse(403, 'forbidden', 'UCP-Agent names a different profile than this key is for.');
  if (!(await ucpSettings()).checkoutFlowId)
    return refuse(404, 'not_found', 'Agentic checkout is not turned on for this workspace.');
  // Each platform has its own budget, like an MCP or A2A client.
  const limited = await overBudget('AGENT_LIMIT', `${UCP_PATH}:${row.id}`);
  if (limited) return limited;

  const caller: PlatformCaller = {
    id: row.id,
    name: row.name,
    profileUrl: row.profileUrl,
    origin: url.origin,
  };
  const headers = new Headers(request.headers);
  // The engine trusts the signed header; the platform's key stays here.
  headers.delete('authorization');
  headers.delete('x-api-key');
  headers.delete('cookie');
  headers.delete(PRINCIPAL_HEADER);
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key)
    throw new Error('PRINCIPAL_KEY is not set: the engine would refuse every forwarded call');
  headers.set(PRINCIPAL_HEADER, await signPlatform(key, caller, url.pathname));
  return engine().fetch(
    new Request(`https://engine${url.pathname}${url.search}`, new Request(request, { headers })),
  );
}

/**
 * The business profile, public like the Agent Card: built by the engine for this origin. 404
 * while agentic checkout is off. UCP asks for a public cache of at least a minute.
 */
export async function ucpDiscovery(url: URL): Promise<Response> {
  const profile = await engine().ucpProfile(url.origin);
  if (!profile)
    return Response.json(ucpError('not_found', 'This business does not offer UCP checkout.'), {
      status: 404,
      headers: { 'cache-control': 'public, max-age=60' },
    });
  return Response.json(profile, { headers: { 'cache-control': 'public, max-age=300' } });
}
