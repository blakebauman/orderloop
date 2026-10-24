/**
 * The workspace tools over MCP (streamable HTTP at `/mcp`): the same tools as the assistant
 * (assistant/tools.ts), for MCP clients such as Claude, Claude Code or Cursor.
 *
 * The web Worker owns `/mcp` on the public origin: it authenticates the caller (an OAuth grant or
 * an `ol_live_` API token), checks Origin, and forwards here over the service binding with the
 * principal header, as it does for the agent sockets. This layer trusts that header, like the rest
 * of EngineApi. Each request is answered by a fresh server listing only the tools the caller's
 * role can use. An action (decide, deliver, cancel, publish, stock review) runs only on a second
 * call carrying the one-time code the first call returned with its preview (confirmations.ts).
 */

import { env } from 'cloudflare:workers';
import { McpServer } from '@modelcontextprotocol/server';
import { ASSISTANT_TOOLS, type AssistantTool, atLeast, type Principal } from '@orderloop/core';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { previewAction, Refused } from './assistant/data';
import { isActionTool, runTool, TOOL_INPUTS, type ToolInput } from './assistant/tools';
import { issueConfirmation, useConfirmation } from './confirmations';
import { forwardedPrincipal } from './principal';

export const MCP_PATH = '/mcp';

/** Tools that save something without a confirm (nothing they save runs until someone approves it). */
const WRITES_WITHOUT_CONFIRM = new Set<AssistantTool>(['draft_plugin']);

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

const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

function createServer(p: Principal) {
  const server = new McpServer(
    { name: 'orderloop', title: 'OrderLoop', version: '1.0.0' },
    {
      instructions:
        'OrderLoop runs each commerce order as a flow graph of steps; people step in at approvals, events and exceptions. Start with needs_attention or find_orders. Orders are named by id (ord_…) or #reference. Actions (deciding, delivering an event, cancelling, publishing, the stock review) take two calls: the first returns a preview and a confirmation code and changes nothing; call again with the code only after the person agrees.',
    },
  );
  for (const name of Object.keys(ASSISTANT_TOOLS) as AssistantTool[]) {
    const t = ASSISTANT_TOOLS[name];
    if (!atLeast(p.role, t.role)) continue;
    // A draft runs without a confirm, but it writes (a pending plugin), so it isn't read-only.
    const readOnly = !t.confirm && !WRITES_WITHOUT_CONFIRM.has(name);
    const action = isActionTool(name);
    server.registerTool(
      name,
      {
        title: t.title,
        description: action
          ? `${t.description} Call it once to get a preview and a confirmation code; show the preview to the person, and only once they agree call it again with the same input and \`confirmation\`.`
          : t.description,
        inputSchema: action
          ? (TOOL_INPUTS[name] as z.ZodObject).extend({
              confirmation: z
                .string()
                .max(100)
                .optional()
                .describe('The code a first call returned, once the person has agreed'),
            })
          : TOOL_INPUTS[name],
        annotations: {
          title: t.title,
          readOnlyHint: readOnly,
          destructiveHint: !readOnly && DESTRUCTIVE.has(name),
          idempotentHint: readOnly || IDEMPOTENT.has(name),
          openWorldHint: false,
        },
      },
      async (raw: ToolInput<typeof name> & { confirmation?: string }) => {
        try {
          if (!action) return result(await runTool(env, p, name, raw, { via: 'MCP' }));
          const { confirmation, ...input } = raw;
          if (!confirmation) {
            const preview = await previewAction(env, p, name, input as never);
            if (preview.blocked) return refusal(preview.blocked);
            const { code, expiresAt } = await issueConfirmation(env, p, name, input);
            return result({
              preview,
              confirmation: code,
              expiresAt,
              next: 'Nothing has happened yet. Show the person this preview; if they agree, call again with the same input and this confirmation.',
            });
          }
          if (!(await useConfirmation(env, p, name, input, confirmation)))
            return refusal(
              'That confirmation is not valid: it expired, was already used, or was for a different action or input. Call without it for a new preview.',
            );
          return result(
            await runTool(env, p, name, input as ToolInput<typeof name>, { via: 'MCP' }),
          );
        } catch (err) {
          // A refusal (wrong role, nothing waiting, already decided) is the model's to read.
          if (err instanceof Refused) return refusal(err.message);
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

/** Serves an MCP request the web Worker forwarded, or 401 without its signed principal header. */
export async function handleMcp(request: Request): Promise<Response> {
  const proxied = await forwardedPrincipal(env, request);
  if (!proxied) return new Response('Unauthorized', { status: 401 });
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
