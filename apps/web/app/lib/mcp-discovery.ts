/**
 * Discovery for `/mcp` before a client connects (MCP Server Cards, SEP-2127): the card at
 * `/mcp/server-card` says what the server is, where to connect and which protocol revisions it
 * speaks; `/.well-known/ai-catalog.json` lists it for clients crawling the domain. Both are public,
 * cacheable and the same for everyone: no tools, roles or capabilities, which a client learns
 * from `server/discover` once connected (apps/engine/src/mcp.ts), and which win if they disagree.
 */

import { MCP_PATH } from './oauth.server';

export const SERVER_CARD_PATH = `${MCP_PATH}/server-card`;
export const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';

const CARD_TYPE = 'application/mcp-server-card+json';
const CATALOG_TYPE = 'application/ai-catalog+json';

/** What the engine serves, newest first (createMcpHandler with `legacy: 'stateless'`). */
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

/** `orderloop.app` → `app.orderloop`: the card's reverse-DNS namespace is the deployment's host. */
const namespaceOf = (host: string) => host.split('.').reverse().join('.');

export function serverCard(origin: string) {
  const { hostname } = new URL(origin);
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: `${namespaceOf(hostname)}/mcp`,
    // Matches the serverInfo the engine reports.
    version: '1.0.0',
    title: 'OrderLoop',
    description:
      'Find, read and act on orders, approvals, flows and stock in an OrderLoop workspace.',
    websiteUrl: 'https://docs.orderloop.app/reference/mcp/',
    icons: [{ src: `${origin}/favicon.svg`, mimeType: 'image/svg+xml' }],
    remotes: [
      {
        type: 'streamable-http',
        url: `${origin}${MCP_PATH}`,
        supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
      },
    ],
  };
}

export function aiCatalog(origin: string) {
  const { hostname } = new URL(origin);
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: `urn:air:${hostname}:mcp:orderloop`,
        type: CARD_TYPE,
        url: `${origin}${SERVER_CARD_PATH}`,
      },
    ],
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag',
};

async function etagOf(body: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `"${Array.from(new Uint8Array(hash).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

/** Serves the card or the catalog, or null for any other path. */
export async function mcpDiscovery(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const doc =
    url.pathname === SERVER_CARD_PATH
      ? { type: CARD_TYPE, value: serverCard(url.origin) }
      : url.pathname === AI_CATALOG_PATH
        ? { type: CATALOG_TYPE, value: aiCatalog(url.origin) }
        : null;
  if (!doc) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET', ...CORS } });
  const body = JSON.stringify(doc.value);
  const etag = await etagOf(body);
  const headers = {
    ...CORS,
    'content-type': doc.type,
    'cache-control': 'public, max-age=3600',
    etag,
  };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}
