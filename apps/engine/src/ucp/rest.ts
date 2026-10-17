/**
 * UCP over HTTP, as the web Worker forwards it: REST under `/ucp/v1` and MCP at `/ucp/mcp`
 * (./mcp.ts). The web Worker has checked the platform's key and `UCP-Agent` and signed the
 * platform onto the request (`signPlatform`); this layer believes that header only, negotiates
 * against the platform's profile, and runs the operation.
 *
 *   POST /ucp/v1/checkout-sessions                 create (201)
 *   GET  /ucp/v1/checkout-sessions/:id
 *   PUT  /ucp/v1/checkout-sessions/:id             update (full replacement)
 *   POST /ucp/v1/checkout-sessions/:id/complete    Idempotency-Key required
 *   POST /ucp/v1/checkout-sessions/:id/cancel      Idempotency-Key required
 *   GET  /ucp/v1/orders/:id
 */

import {
  type PlatformCaller,
  PRINCIPAL_HEADER,
  UCP_MCP_PATH,
  UCP_REST_PATH,
  ucpCheckoutInput,
  ucpError,
  ucpErrorResponse,
  verifyPlatform,
} from '@orderloop/core';
import {
  cancelCheckout,
  completeCheckout,
  createCheckout,
  getCheckout,
  getOrder,
  type UcpContext,
  type UcpResult,
  updateCheckout,
} from './checkout';
import { once } from './idempotency';
import { handleUcpMcp } from './mcp';
import { negotiated, ProfileError } from './platform';

const MAX_BODY = 256 * 1024;

const json = (r: UcpResult, requestId?: string | null) =>
  Response.json(r.body, {
    status: r.status,
    headers: { 'cache-control': 'no-store', ...(requestId ? { 'request-id': requestId } : {}) },
  });

const refuse = (status: number, code: string, content: string): UcpResult => ({
  status,
  body: ucpError(code, content),
});

/** The platform the web Worker signed onto this request, or null. */
export function platformOf(env: Env, request: Request): Promise<PlatformCaller | null> {
  return verifyPlatform(
    [env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS],
    request.headers.get(PRINCIPAL_HEADER),
    new URL(request.url).pathname,
  );
}

/**
 * The context for a platform's request: its negotiated capabilities, or the response that
 * refuses it (an unreadable profile, a newer protocol, nothing in common).
 */
export async function contextFor(
  env: Env,
  caller: PlatformCaller,
): Promise<{ ctx: UcpContext } | { refusal: UcpResult }> {
  try {
    const { negotiation } = await negotiated(env, caller);
    if (negotiation.ok) return { ctx: { caller, capabilities: negotiation.capabilities } };
    if (negotiation.code === 'version_unsupported')
      return { refusal: refuse(422, negotiation.code, negotiation.content) };
    return {
      refusal: {
        status: 200,
        body: ucpErrorResponse([
          {
            kind: 'error',
            code: negotiation.code,
            content: negotiation.content,
            severity: 'unrecoverable',
          },
        ]),
      },
    };
  } catch (err) {
    if (err instanceof ProfileError) return { refusal: refuse(err.status, err.code, err.message) };
    throw err;
  }
}

async function readBody(request: Request): Promise<string | null> {
  const text = await request.text();
  return text.length > MAX_BODY ? null : text;
}

export async function handleUcp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const caller = await platformOf(env, request);
  if (!caller) return json(refuse(401, 'unauthorized', 'Unauthorized'));
  if (url.pathname === UCP_MCP_PATH) return handleUcpMcp(request, env, caller);
  const requestId = request.headers.get('request-id');
  const reply = (r: UcpResult) => json(r, requestId);

  const negotiation = await contextFor(env, caller);
  if ('refusal' in negotiation) return reply(negotiation.refusal);
  const { ctx } = negotiation;

  const parts = url.pathname.slice(UCP_REST_PATH.length).split('/').filter(Boolean);
  const method = request.method;
  const key = request.headers.get('idempotency-key');
  const body = method === 'GET' ? '' : await readBody(request);
  if (body === null) return reply(refuse(413, 'too_large', 'The request body is too large.'));
  const parse = () => {
    try {
      return { value: body ? (JSON.parse(body) as unknown) : {} };
    } catch {
      return null;
    }
  };
  /** Runs a write under its Idempotency-Key, when the platform sent one. */
  const write = (op: () => Promise<UcpResult>, required = false) => {
    if (!key)
      return required
        ? Promise.resolve(refuse(400, 'idempotency_key_required', 'Send an Idempotency-Key.'))
        : op();
    if (key.length < 16 || key.length > 255)
      return Promise.resolve(
        refuse(400, 'invalid_idempotency_key', 'Idempotency-Key must be 16–255 characters.'),
      );
    return once(env, caller.id, key, `${method} ${url.pathname}`, body, op);
  };

  if (parts[0] === 'checkout-sessions') {
    const id = parts[1];
    if (!id && parts.length === 1 && method === 'POST') {
      const input = ucpCheckoutInput.safeParse(parse()?.value);
      if (!input.success)
        return reply(
          refuse(400, 'invalid_request', input.error.issues[0]?.message ?? 'Invalid checkout'),
        );
      return reply(await write(() => createCheckout(env, ctx, input.data)));
    }
    if (id && parts.length === 2 && method === 'GET') return reply(await getCheckout(env, ctx, id));
    if (id && parts.length === 2 && method === 'PUT') {
      const input = ucpCheckoutInput.safeParse(parse()?.value);
      if (!input.success)
        return reply(
          refuse(400, 'invalid_request', input.error.issues[0]?.message ?? 'Invalid checkout'),
        );
      return reply(await write(() => updateCheckout(env, ctx, id, input.data)));
    }
    if (id && parts.length === 3 && method === 'POST' && parts[2] === 'complete') {
      const raw = parse();
      if (!raw) return reply(refuse(400, 'invalid_request', 'The body is not JSON.'));
      return reply(await write(() => completeCheckout(env, ctx, id, raw.value), true));
    }
    if (id && parts.length === 3 && method === 'POST' && parts[2] === 'cancel')
      return reply(await write(() => cancelCheckout(env, ctx, id), true));
  }
  if (parts[0] === 'orders' && parts.length === 2 && method === 'GET')
    return reply(await getOrder(env, ctx, parts[1]!));
  return reply(refuse(404, 'not_found', 'Not found'));
}
