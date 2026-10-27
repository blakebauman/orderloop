/** Punchout partners in the plugin's own database (migrations/0001_init.sql). */

import type { ExternalCartInput } from '@orderloop/core';
import { type PluginDatabase, pluginDb } from '@orderloop/plugin-sdk';

export const PROTOCOLS = ['cxml', 'oci'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export type Partner = {
  id: string;
  name: string;
  protocol: Protocol;
  fromDomain: string;
  identity: string;
  secretHash: string;
  supplierDomain: string;
  supplierIdentity: string;
  customerId: string | null;
  flowId: string;
  model: string;
  returnHosts: string[];
  frameOrigins: string[];
  /** The partner's idle timeout: a cart closes this long after its buyer stops working on it. */
  sessionMinutes: number;
  status: 'active' | 'disabled';
};

type Row = Record<string, unknown>;

const fromRow = (r: Row): Partner => ({
  id: String(r.id),
  name: String(r.name),
  protocol: r.protocol as Protocol,
  fromDomain: String(r.from_domain ?? ''),
  identity: String(r.identity),
  secretHash: String(r.secret_hash),
  supplierDomain: String(r.supplier_domain),
  supplierIdentity: String(r.supplier_identity),
  customerId: (r.customer_id as string | null) ?? null,
  flowId: String(r.flow_id),
  model: String(r.model),
  returnHosts: JSON.parse(String(r.return_hosts ?? '[]')) as string[],
  frameOrigins: JSON.parse(String(r.frame_origins ?? '[]')) as string[],
  sessionMinutes: Number(r.session_minutes),
  status: r.status === 'disabled' ? 'disabled' : 'active',
});

const db = (env: object): PluginDatabase => pluginDb(env);

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether `secret` is the partner's, compared in constant time. */
export async function secretMatches(p: Partner, secret: string | null): Promise<boolean> {
  if (!secret) return false;
  const a = new TextEncoder().encode(await sha256(secret));
  const b = new TextEncoder().encode(p.secretHash);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

/** A new secret, to show once. */
export const newSecret = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** The active partner with any of these credentials, for `protocol`. */
export async function findPartner(
  env: object,
  protocol: Protocol,
  creds: { domain: string; identity: string }[],
): Promise<Partner | null> {
  for (const c of creds) {
    const r = await db(env)
      .prepare(
        "SELECT * FROM partners WHERE protocol = ? AND lower(from_domain) = lower(?) AND identity = ? AND status = 'active'",
      )
      .bind(protocol, c.domain, c.identity)
      .first<Row>();
    if (r) return fromRow(r);
  }
  return null;
}

export async function getPartner(env: object, id: string): Promise<Partner | null> {
  const r = await db(env).prepare('SELECT * FROM partners WHERE id = ?').bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function listPartners(env: object): Promise<Partner[]> {
  const r = await db(env).prepare('SELECT * FROM partners ORDER BY name').all<Row>();
  return r.results.map(fromRow);
}

export type PartnerInput = Omit<Partner, 'id' | 'secretHash' | 'status'>;

/** Adds a partner; answers it with its secret, shown once. */
export async function addPartner(env: object, p: PartnerInput) {
  const id = `ptn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const secret = newSecret();
  const now = Date.now();
  await db(env)
    .prepare(
      `INSERT INTO partners (id, name, protocol, from_domain, identity, secret_hash, supplier_domain,
        supplier_identity, customer_id, flow_id, model, return_hosts, frame_origins, session_minutes,
        status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      id,
      p.name,
      p.protocol,
      p.fromDomain,
      p.identity,
      await sha256(secret),
      p.supplierDomain,
      p.supplierIdentity,
      p.customerId,
      p.flowId,
      p.model,
      JSON.stringify(p.returnHosts),
      JSON.stringify(p.frameOrigins),
      p.sessionMinutes,
      now,
      now,
    )
    .run();
  return { id, secret };
}

/** A new secret for the partner, replacing the old one at once; shown once. */
export async function rotateSecret(env: object, id: string): Promise<string | null> {
  const secret = newSecret();
  const r = await db(env)
    .prepare('UPDATE partners SET secret_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await sha256(secret), Date.now(), id)
    .run();
  return r.meta.changes ? secret : null;
}

export async function setStatus(env: object, id: string, status: 'active' | 'disabled') {
  await db(env)
    .prepare('UPDATE partners SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, Date.now(), id)
    .run();
}

export async function recordSession(
  env: object,
  s: { cartId: string; partnerId: string; buyerCookie: string; operation: string },
) {
  await db(env)
    .prepare(
      `INSERT INTO sessions (cart_id, partner_id, buyer_cookie, operation, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cart_id) DO UPDATE SET operation = excluded.operation`,
    )
    .bind(s.cartId, s.partnerId, s.buyerCookie, s.operation, Date.now())
    .run();
}

export async function sessionOf(env: object, cartId: string) {
  return db(env)
    .prepare('SELECT * FROM sessions WHERE cart_id = ?')
    .bind(cartId)
    .first<{ cart_id: string; partner_id: string; buyer_cookie: string; operation: string }>();
}

/** Whether a return or HOOK_URL goes to one of the partner's hosts, over https. */
export function returnAllowed(p: Partner, raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' && !u.username && p.returnHosts.includes(u.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** The cart the partner's session opens, as `openExternalCart` is asked for it. */
export function cartInput(
  p: Partner,
  s: {
    sessionRef: string;
    buyer: { id: string; name: string };
    returnUrl: string;
    lines?: { sku: string; qty: number }[];
  },
): ExternalCartInput {
  const idleMs = Math.min(p.sessionMinutes, 24 * 60) * 60_000;
  return {
    sessionRef: s.sessionRef,
    title: `${p.name} punchout`,
    flowId: p.flowId,
    customerId: p.customerId,
    buyer: s.buyer,
    returnUrl: s.returnUrl,
    frameOrigins: p.frameOrigins,
    // The partner's session timeout is an idle timeout: the cart stays open while the buyer works
    // on it, and closes that long after they stop (24 hours from opening at most, the core's cap).
    expiresAt: Date.now() + idleMs,
    idleMs,
    ...(s.lines?.length ? { lines: s.lines } : {}),
  };
}
