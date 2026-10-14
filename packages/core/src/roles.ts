/**
 * Who may do what. Roles are ordered: each one can do everything the roles before it can.
 *
 * - `viewer` reads orders, flows, approvals and the back office, and asks the workspace assistant.
 * - `approver` also decides approvals.
 * - `operator` also starts, cancels and restarts orders, delivers events, edits and publishes
 *   flows, runs the stock review, and manages the team, API tokens and webhooks.
 */

export const ROLES = ['viewer', 'approver', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  approver: 'Approver',
  operator: 'Operator',
};

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

/** True when `role` is at least `min`. */
export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/**
 * Who is acting. `id` is stable (`usr_…`, `tok_…`, or a fixed id for the shared password and open
 * local dev); `name` is what the audit trail shows, such as an approval's `by`.
 */
export type Principal = {
  kind: 'user' | 'token' | 'password' | 'open';
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
 * The header the web app sets when it proxies the order page's agent connection, after removing
 * any copy the browser sent. The engine is reachable only through that proxy.
 */
export const PRINCIPAL_HEADER = 'x-orderloop-principal';

/**
 * What the proxy header carries: the principal plus, for a signed-in person, their session's id
 * (the SHA-256 the `sessions` table is keyed by), so the agent can check the session is still live.
 * The session id never reaches the browser.
 */
export type ProxiedPrincipal = Principal & { session?: string };

export function encodePrincipal(p: ProxiedPrincipal): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(p))));
}

/** The principal in a proxied request, or null when the header is missing or malformed. */
export function decodePrincipal(header: string | null | undefined): ProxiedPrincipal | null {
  if (!header) return null;
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ProxiedPrincipal>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || !isRole(p.role)) return null;
    return {
      kind: p.kind ?? 'user',
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      ...(typeof p.session === 'string' ? { session: p.session } : {}),
    };
  } catch {
    return null;
  }
}
