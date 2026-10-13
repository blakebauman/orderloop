/**
 * Cross-site request protection. A browser attaches the session cookie to requests from other
 * sites on the same registrable domain (every *.orderloop.io host counts as the same site, so
 * SameSite=Lax doesn't stop them). Anything that changes state, and the order page's WebSocket,
 * must therefore come from this app's own origin.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a browser sent this state-changing request (or WebSocket upgrade) from another origin.
 * Browsers always send `Origin` on such requests; `Sec-Fetch-Site` is the fallback. A request with
 * neither isn't from a browser, so it carries no ambient cookie to abuse.
 */
export function crossOrigin(request: Request, origin: string): boolean {
  const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (SAFE_METHODS.has(request.method) && !upgrade) return false;
  const from = request.headers.get('origin');
  if (from !== null) return from !== origin;
  const site = request.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  return false;
}
