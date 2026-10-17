/**
 * Who may do what. Roles are ordered: each one can do everything the roles before it can.
 *
 * - `viewer` reads orders, flows, approvals and the back office, and asks the workspace assistant.
 * - `approver` also decides approvals.
 * - `operator` also starts, cancels and restarts orders, delivers events, edits and publishes
 *   flows, and runs the stock review.
 * - `admin` also manages the team, API tokens, webhooks and integrations, the workspace's
 *   settings, and reads the audit log.
 */

export const ROLES = ['viewer', 'approver', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  approver: 'Approver',
  operator: 'Operator',
  admin: 'Admin',
};

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

/** True when `role` is at least `min`. */
export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/**
 * Who is acting. `id` is stable (`usr_…`, `tok_…`, or a fixed id for open local dev); `name` is what the audit trail shows, such as an approval's `by`.
 */
export type Principal = {
  kind: 'user' | 'token' | 'open';
  id: string;
  name: string;
  email?: string;
  role: Role;
};

/** A session ends this long after sign-in, whatever happens. */
export const SESSION_MAX_MS = 30 * 86_400_000;
/** A session also ends after this long without a request, on a page or the order page's socket. */
export const SESSION_IDLE_MS = 7 * 86_400_000;
/** Activity is written back at most this often. */
export const SESSION_TOUCH_MS = 5 * 60_000;

/**
 * The header the web app sets when it forwards a request to the engine (the order page's and the
 * assistant's sockets, `/mcp` and `/a2a`), after removing any copy the caller sent. The engine is
 * reachable only through the web app's service binding, and it still believes the header only
 * when it is signed: an HMAC over the principal, the path it was sent to and an expiry, under the
 * `PRINCIPAL_KEY` secret the two Workers share.
 */
export const PRINCIPAL_HEADER = 'x-orderloop-principal';

/**
 * What the proxy header carries: the principal plus, for a signed-in person, their session's id
 * (the SHA-256 the `sessions` table is keyed by), so the agent can check the session is still live.
 * The session id never reaches the browser.
 */
export type ProxiedPrincipal = Principal & { session?: string };

/** How long a signed header is good for. A socket is checked once, when it connects. */
export const PRINCIPAL_TTL_MS = 60_000;

/** Local dev's key (`vite.config.ts` gives it to both Workers). Never a deployment's. */
export const DEV_PRINCIPAL_KEY = 'orderloop-local-dev-principal-key';

const PRINCIPAL_VERSION = 'v1';
const enc = new TextEncoder();
const keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();

function hmacKey(secret: string) {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keys.set(secret, key);
  }
  return key;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/**
 * The header value for `p`, good for requests to `path` until `now + PRINCIPAL_TTL_MS`:
 * `v1.<payload>.<signature>`, both base64url.
 */
export async function signPrincipal(
  secret: string,
  p: ProxiedPrincipal,
  path: string,
  now = Date.now(),
): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ p, path, exp: now + PRINCIPAL_TTL_MS })));
  const signed = `${PRINCIPAL_VERSION}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signed));
  return `${signed}.${b64url(new Uint8Array(sig))}`;
}

/**
 * The principal in a forwarded request, or null unless the header is signed by one of `secrets`
 * (the current key, then the one before it while a rotation finishes), names this `path` and
 * hasn't expired.
 */
export async function verifyPrincipal(
  secrets: readonly (string | undefined)[],
  header: string | null | undefined,
  path: string,
  now = Date.now(),
): Promise<ProxiedPrincipal | null> {
  if (!header) return null;
  const [version, payload, sig, extra] = header.split('.');
  if (version !== PRINCIPAL_VERSION || !payload || !sig || extra !== undefined) return null;
  try {
    const data = enc.encode(`${version}.${payload}`);
    const mac = fromB64url(sig);
    let valid = false;
    for (const secret of secrets)
      if (secret && (await crypto.subtle.verify('HMAC', await hmacKey(secret), mac, data))) {
        valid = true;
        break;
      }
    if (!valid) return null;
    const body = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as {
      p?: Partial<ProxiedPrincipal>;
      path?: unknown;
      exp?: unknown;
    };
    if (body.path !== path || typeof body.exp !== 'number' || body.exp <= now) return null;
    const p = body.p;
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !isRole(p.role))
      return null;
    if (p.kind !== 'user' && p.kind !== 'token' && p.kind !== 'open') return null;
    return {
      kind: p.kind,
      id: p.id,
      name: p.name,
      ...(typeof p.email === 'string' ? { email: p.email } : {}),
      role: p.role,
      ...(typeof p.session === 'string' ? { session: p.session } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The workspace setting (`workspace_settings`) that keeps whoever started an order from deciding
 * its approvals: `on` or `off` (the default).
 */
export const APPROVAL_SEPARATION_KEY = 'approval_separation';

export const OWN_ORDER_REFUSAL =
  'You started this order, so someone else must decide its approvals.';

/**
 * Why `deciderId` may not decide an approval on an order that `startedBy` started, or null. Only
 * with separation on, and only when both are known: an order from a channel, an email or the
 * stock review has no starter, and anyone with the role may decide it.
 */
export function ownOrderRefusal(
  separate: boolean,
  startedBy: string | null | undefined,
  deciderId: string | null | undefined,
): string | null {
  return separate && startedBy && startedBy === deciderId ? OWN_ORDER_REFUSAL : null;
}
