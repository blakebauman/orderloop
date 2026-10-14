/**
 * The workspace tools over MCP (streamable HTTP at `/mcp`): the same tools as the assistant
 * (assistant/tools.ts), for MCP clients such as Claude, Claude Code or Cursor.
 *
 * The web Worker owns `/mcp` on the public origin: it authenticates the caller (an OAuth grant or
 * an `ol_live_` API token), checks Origin, and forwards here over the service binding with the
 * principal header, as it does for the agent sockets. This layer trusts that header, like the rest
 * of EngineApi. Each request is answered by a fresh server listing only the tools the caller's
 * role can use; nothing is kept between requests.
 */

import { env } from 'cloudflare:workers';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ASSISTANT_TOOLS,
  type AssistantTool,
  atLeast,
  decodePrincipal,
  PRINCIPAL_HEADER,
  type Principal,
} from '@orderloop/core';
import { createMcpHandler } from 'agents/mcp/server';
import { Refused } from './assistant/data';
import { runTool, TOOL_INPUTS, type ToolInput } from './assistant/tools';

export const MCP_PATH = '/mcp';

/** Actions that can't be taken back by calling them again: a client should confirm them. */
const DESTRUCTIVE = new Set<AssistantTool>(['decide_approval', 'cancel_order', 'publish_flow']);
/** Calling these twice with the same input does nothing more the second time. */
const IDEMPOTENT = new Set<AssistantTool>(['decide_approval', 'cancel_order']);

const result = (value: unknown) => {
  const structured =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: structured,
  };
};

function createServer(p: Principal) {
  const server = new McpServer(
    { name: 'orderloop', title: 'OrderLoop', version: '1.0.0' },
    {
      instructions:
        'OrderLoop runs each commerce order as a flow graph of steps; people step in at approvals, events and exceptions. Start with needs_attention or find_orders. Orders are named by id (ord_…) or #reference.',
    },
  );
  for (const name of Object.keys(ASSISTANT_TOOLS) as AssistantTool[]) {
    const t = ASSISTANT_TOOLS[name];
    if (!atLeast(p.role, t.role)) continue;
    const readOnly = !t.confirm;
    server.registerTool(
      name,
      {
        title: t.title,
        description: t.description,
        inputSchema: TOOL_INPUTS[name],
        annotations: {
          title: t.title,
          readOnlyHint: readOnly,
          destructiveHint: !readOnly && DESTRUCTIVE.has(name),
          idempotentHint: readOnly || IDEMPOTENT.has(name),
          openWorldHint: false,
        },
      },
      async (input: ToolInput<typeof name>) => {
        try {
          return result(await runTool(env, p, name, input, { via: 'MCP' }));
        } catch (err) {
          // A refusal (wrong role, nothing waiting, already decided) is the model's to read.
          if (err instanceof Refused)
            return { content: [{ type: 'text' as const, text: err.message }], isError: true };
          throw err;
        }
      },
    );
  }
  return server;
}

const handler = createMcpHandler(
  (ctx) => createServer(ctx.authInfo?.extra?.principal as Principal),
  {
    route: MCP_PATH,
    // Reached only through the service binding (the engine has no public route), so Host means
    // nothing here; the web Worker validates Origin before forwarding.
    allowedOriginHostnames: '*',
    corsOptions: false,
  },
);

/** Serves an MCP request the web Worker forwarded, or 401 without its principal header. */
export function handleMcp(request: Request): Promise<Response> {
  const proxied = decodePrincipal(request.headers.get(PRINCIPAL_HEADER));
  if (!proxied) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
  const { session: _session, ...principal } = proxied;
  return handler.fetch(request, {
    authInfo: {
      token: 'proxied',
      clientId: principal.id,
      scopes: [principal.role],
      extra: { principal },
    },
  });
}
