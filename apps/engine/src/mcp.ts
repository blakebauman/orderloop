/**
 * The workspace tools over MCP (streamable HTTP at `/mcp`): the same tools as the assistant
 * (assistant/tools.ts), for MCP clients such as Claude, Claude Code or Cursor.
 *
 * The web Worker owns `/mcp` on the public origin: it authenticates the caller (an OAuth grant or
 * an `ol_live_` API token), checks Origin, and forwards here over the service binding with the
 * principal header, as it does for the agent sockets. This layer trusts that header, like the rest
 * of EngineApi. Each request is answered by a fresh server listing only the tools the caller's
 * role can use. An action (decide, deliver, cancel, submit a cart, publish, stock review) runs only on a second
 * call carrying the one-time code the first call returned with its preview (confirmations.ts).
 */

import { env } from 'cloudflare:workers';
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import { memorySkillFiles, SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import {
  type ActionPreview,
  ASSISTANT_TOOLS,
  type AssistantTool,
  atLeast,
  boundText,
  isWriteTool,
  mcpSkillFiles,
  type Principal,
  type Role,
} from '@orderloop/core';
import { z } from 'zod';
import { previewAction, Refused } from './assistant/data';
import {
  isActionTool,
  runTool,
  TOOL_INPUTS,
  TOOL_OUTPUTS,
  type ToolInput,
} from './assistant/tools';
import { issueConfirmation, redeemConfirmation, useConfirmation } from './confirmations';
import { forwardedPrincipal } from './principal';

export const MCP_PATH = '/mcp';

/** Actions that can't be taken back by calling them again: a client should confirm them. */
const DESTRUCTIVE = new Set<AssistantTool>([
  'decide_approval',
  'cancel_order',
  'submit_cart',
  'publish_flow',
]);
/** Calling these twice with the same input does nothing more the second time. */
const IDEMPOTENT = new Set<AssistantTool>(['decide_approval', 'cancel_order', 'submit_cart']);
/**
 * These reach outside OrderLoop: cancelling voids payments and cancels shipments with the
 * carrier, a submitted cart's order runs its flow (payments, shipping), the stock review places
 * supplier reorders, and an assessment may fetch an https image.
 */
const OPEN_WORLD = new Set<AssistantTool>([
  'cancel_order',
  'submit_cart',
  'run_stock_review',
  'assess_order',
]);

/** Every tool returns an object (TOOL_OUTPUTS), sent as JSON text and as structured content. */
const result = (value: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

/** These wait on a model; a client that asked for progress hears that it started. */
const SLOW: Partial<Record<AssistantTool, string>> = {
  assess_order: 'Assessing the order…',
  propose_flow_change: 'Drafting the change…',
};

/** What the person answers when their client asks them to confirm an action. */
const CONFIRM = z.object({ confirm: z.boolean().describe('Go ahead with this') });

/**
 * Whether the client asks its person itself (a 2026-07-28 request declaring form elicitation).
 * Then an action's first call is an elicitation the client shows, not a code for the model.
 */
function canElicit(ctx: { mcpReq: { envelope?: object } }) {
  const caps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    CLIENT_CAPABILITIES_META_KEY
  ] as { elicitation?: { form?: object; url?: object } } | undefined;
  const e = caps?.elicitation;
  return !!e && (!!e.form || !e.url);
}

/** Marks the input an elicited confirmation is bound to (see the action branch below). */
const ELICITED = '@confirmedBy:elicitation';

/**
 * The question a client shows its person: a fixed line naming the action, then the preview, whose
 * text can come from orders and customers, so each line is one bounded line.
 */
function confirmMessage(name: AssistantTool, preview: ActionPreview) {
  const lines = [preview.title, ...preview.consequences]
    .map((l) => boundText(l, 200))
    .filter((l): l is string => !!l);
  return [
    `OrderLoop asks you to confirm: ${ASSISTANT_TOOLS[name].title}.`,
    ...lines.map((l) => `• ${l}`),
  ].join('\n');
}

const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/**
 * The skills a role can follow (MCP_SKILLS in @orderloop/core), served with the Skills extension:
 * `skills/list`, `skills/get` and `resources/read` on `skill://<name>/SKILL.md`, with the
 * digests and sizes the SDK computes. One catalog per role, built once per isolate.
 */
const catalogs = new Map<Role, Promise<SkillCatalog>>();
function catalogFor(role: Role) {
  let c = catalogs.get(role);
  if (!c) {
    c = SkillCatalog.load(memorySkillFiles(mcpSkillFiles(role)), {
      strict: true,
      // Per role, so per client; the skills change only with a deploy.
      cacheHint: { ttlMs: 300_000, cacheScope: 'private' },
    });
    // A failed build is retried on the next request rather than cached.
    c.catch(() => catalogs.delete(role));
    catalogs.set(role, c);
  }
  return c;
}

async function createServer(p: Principal) {
  const server = new McpServer(
    { name: 'orderloop', title: 'OrderLoop', version: '1.0.0' },
    {
      // tools/list depends on the caller's role: cache it per client, briefly, so a demotion
      // narrows the list within a minute.
      cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } },
      instructions:
        'OrderLoop runs each commerce order as a flow graph of steps; people step in at approvals, events and exceptions. Start with needs_attention or find_orders. Orders are named by id (ord_…) or #reference. Carts (cart_…) are built with create_cart and change_cart and become orders with submit_cart. Actions (deciding, delivering an event, cancelling, submitting a cart, publishing, the stock review) take two calls: the first returns a preview and a confirmation code and changes nothing; call again with the code only after the person agrees.',
    },
  );
  for (const name of Object.keys(ASSISTANT_TOOLS) as AssistantTool[]) {
    const t = ASSISTANT_TOOLS[name];
    if (!atLeast(p.role, t.role)) continue;
    // A draft runs without a confirm, but it writes (a pending plugin), so it isn't read-only.
    const readOnly = !isWriteTool(name);
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
        outputSchema: TOOL_OUTPUTS[name],
        annotations: {
          title: t.title,
          readOnlyHint: readOnly,
          destructiveHint: !readOnly && DESTRUCTIVE.has(name),
          idempotentHint: readOnly || IDEMPOTENT.has(name),
          openWorldHint: OPEN_WORLD.has(name),
        },
      },
      async (raw: ToolInput<typeof name> & { confirmation?: string }, ctx) => {
        try {
          const progressToken = ctx.mcpReq._meta?.progressToken;
          const slow = SLOW[name];
          if (slow && progressToken !== undefined)
            await ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress: 0, message: slow },
            });
          if (!action)
            return result(
              (await runTool(env, p, name, raw, { via: 'MCP' })) as Record<string, unknown>,
            );
          const { confirmation, ...input } = raw;
          if (canElicit(ctx)) {
            // The model never holds a code here, so it can't send one in place of the person.
            if (confirmation)
              return refusal(
                'This client asks the person to confirm. Call again without `confirmation`.',
              );
            // Bound to a different fingerprint than the two-call code, so neither path accepts
            // the other's code. Input schemas strip unknown keys, so a caller can't add this one.
            const asked = { ...input, [ELICITED]: true };
            // The retry carries the code back as request state, with the person's answer.
            const code = ctx.mcpReq.requestState<string>();
            if (typeof code === 'string' && code) {
              if (
                acceptedContent(ctx.mcpReq.inputResponses, 'confirm', CONFIRM)?.confirm !== true
              ) {
                // A no is final: use the code up so a later "yes" with it does nothing.
                await useConfirmation(env, p, name, asked, code);
                return refusal('The person did not confirm. Nothing happened.');
              }
              const used = await redeemConfirmation(env, p, name, asked, code);
              if (!used)
                return refusal(
                  'That confirmation expired or was already used, or the input changed. Call again for a new preview.',
                );
              return result(
                (await runTool(env, p, name, input as ToolInput<typeof name>, {
                  via: 'MCP',
                  confirmed: used,
                })) as Record<string, unknown>,
              );
            }
            const preview = await previewAction(env, p, name, input as never);
            if (preview.blocked) return refusal(preview.blocked);
            // Held to what the person is shown (a cart's version), kept here, not in the request.
            const issued = await issueConfirmation(env, p, name, asked, undefined, preview.bound);
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: confirmMessage(name, preview),
                  requestedSchema: CONFIRM,
                }),
              },
              // Not trusted on the way back: useConfirmation checks it is this person's unused
              // code for this tool and input.
              requestState: issued.code,
            });
          }
          if (!confirmation) {
            const preview = await previewAction(env, p, name, input as never);
            if (preview.blocked) return refusal(preview.blocked);
            const { bound, ...shown } = preview;
            const { code, expiresAt } = await issueConfirmation(
              env,
              p,
              name,
              input,
              undefined,
              bound,
            );
            return result({
              preview: shown,
              confirmation: code,
              expiresAt,
              next: 'Nothing has happened yet. Show the person this preview; if they agree, call again with the same input and this confirmation.',
            });
          }
          const used = await redeemConfirmation(env, p, name, input, confirmation);
          if (!used)
            return refusal(
              'That confirmation is not valid: it expired, was already used, or was for a different action or input. Call without it for a new preview.',
            );
          return result(
            (await runTool(env, p, name, input as ToolInput<typeof name>, {
              via: 'MCP',
              confirmed: used,
            })) as Record<string, unknown>,
          );
        } catch (err) {
          // A refusal (wrong role, nothing waiting, already decided) is the model's to read.
          if (err instanceof Refused) return refusal(err.message);
          // Anything else stays here: a database or provider error is not the model's to see.
          console.error('mcp tool', name, err);
          return refusal('Something went wrong on OrderLoop’s side. Try again in a moment.');
        }
      },
    );
  }
  // @experimental in the SDK: how an extension attaches may change in a minor release.
  (await catalogFor(p.role)).attach(server);
  return server;
}

const handler = createMcpHandler(
  (ctx) => createServer(ctx.authInfo?.extra?.principal as Principal),
  {
    // 2025-era requests (no envelope) get a fresh server each, as 2026-07-28 ones do. The engine
    // is reached only through the service binding: the web Worker authenticates the caller and
    // refuses a malformed Origin first.
    legacy: 'stateless',
    onerror: (err) => console.error('mcp', err),
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
