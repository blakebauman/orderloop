/**
 * The assistant's model: Workers AI (through AI Gateway when AI_GATEWAY_ID is set), then a smaller
 * Workers AI model, with a deterministic heuristic model behind both. The heuristic speaks the same
 * protocol, so it calls the same tools through the same approvals; it runs when AI_MODE is "mock",
 * and takes over a turn when the models error or produce nothing within the AI timeout. The
 * assistant never blocks on a model.
 */

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import {
  type AssessAnswers,
  type AssistantContext,
  type AssistantTool,
  describeAnswers,
  promptId,
} from '@orderloop/core';
import { createAI, type GatewayOptions, type WorkersAIModelId } from 'agents/models/ai-sdk';
import { gatewayOptions, NO_LOG_PAYLOAD } from '../ai';
import { orderRef } from './data';

/** Matches the AI nodes: a slow model must not hold a person hostage either. */
const AI_TIMEOUT_MS = 20_000;

/**
 * Tried when ASSISTANT_MODEL fails before saying anything (an error, a capacity refusal): smaller
 * and faster, with multi-turn tool calling, so a turn still gets a model's answer before the
 * heuristic's.
 */
export const ASSISTANT_FALLBACK_MODEL = '@cf/zai-org/glm-4.7-flash';

/**
 * Bounds each gateway attempt but the last (the gateway waits out its final attempt). As long as
 * the whole turn's deadline: a long answer that isn't streamed (A2A) can take most of it, and a
 * shorter bound would cut healthy answers off and retry them.
 */
const ATTEMPT_TIMEOUT_MS = 20_000;

const USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Which model answered: `model` names the Workers AI model when one did. */
export type ModelSource = { source: 'model' | 'heuristic'; model?: string };

/**
 * Whose turn it is, for the gateway: where it came from, the person, and the conversation (the
 * panel has one per person; an A2A caller's context). Neither reaches the gateway as it is.
 */
export type Turn = { surface: 'panel' | 'a2a'; principalId: string; conversation: string };

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * AI Gateway's options for one turn. Every model call of the turn (each tool step, and the
 * fallback model's) shares its event id. With logs on (`aiGatewayLogs`), the entry keeps its
 * metadata, tokens and cost but not its payload: tool results carry customers' names and order details, and the gateway keeps its
 * logs past the app's own erasure. With no gateway the id stays empty rather than undefined:
 * createAI fills in its "default" gateway for undefined, and the AI binding calls Workers AI
 * directly only for an empty id.
 */
export async function assistantGateway(
  env: Env,
  turn: Turn,
): Promise<{ gateway: GatewayOptions; headers: Record<string, string> }> {
  const id = String(env.AI_GATEWAY_ID ?? '');
  if (!id) return { gateway: { id: '' }, headers: {} };
  return {
    gateway: {
      id,
      // The registry's aiGatewayLogs: with logs off the gateway keeps no entry at all.
      collectLog: gatewayOptions(env)?.collectLog ?? false,
      eventId: crypto.randomUUID(),
      metadata: {
        prompt: promptId('assistant'),
        surface: turn.surface,
        principal: (await sha256(`principal:${turn.principalId}`)).slice(0, 16),
      },
      retries: { maxAttempts: 3, retryDelayMs: 500, backoff: 'exponential' },
      requestTimeoutMs: ATTEMPT_TIMEOUT_MS,
    },
    headers: { ...NO_LOG_PAYLOAD },
  };
}

/**
 * The model for one turn. `used.source` says which model answered, so the panel can label a
 * heuristic answer as one.
 */
export async function assistantModel(
  env: Env,
  context: AssistantContext,
  used: ModelSource,
  turn: Turn,
): Promise<LanguageModelV4> {
  const fallback = heuristicModel(context);
  if (String(env.AI_MODE) === 'mock') {
    used.source = 'heuristic';
    return fallback;
  }
  const { gateway, headers } = await assistantGateway(env, turn);
  const ai = createAI({ binding: env.AI, gateway });
  const model = String(env.ASSISTANT_MODEL) as WorkersAIModelId;
  const primary = ai(model, {
    fallback: model === ASSISTANT_FALLBACK_MODEL ? [] : [ASSISTANT_FALLBACK_MODEL],
    // Workers AI's prefix cache: the system prompt and tools (most of a turn's input) repeat
    // within a conversation, so its turns go to the same replica.
    sessionAffinity: await sha256(`conversation:${turn.principalId}:${turn.conversation}`),
    headers,
  });
  return withFallback(primary, fallback, used);
}

function timeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const CONTENT = new Set(['text-delta', 'tool-call', 'tool-input-start', 'reasoning-delta']);

/** The model that answered, from createAI's metadata: the fallback model's, when it did. */
function answeredBy(metadata: unknown): string | undefined {
  const model = (metadata as { cloudflare?: { model?: unknown } } | undefined)?.cloudflare?.model;
  return typeof model === 'string' ? model : undefined;
}

/**
 * Tries the model; if it errors, or nothing useful arrives before the deadline, the heuristic
 * answers instead. Once the model has produced content, its stream passes through untouched.
 */
export function withFallback(
  primary: LanguageModelV4,
  fallback: LanguageModelV4,
  used: ModelSource,
): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'orderloop',
    modelId: primary.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      try {
        const res = await timeout(primary.doGenerate(options), AI_TIMEOUT_MS);
        used.source = 'model';
        used.model = answeredBy(res.providerMetadata) ?? primary.modelId;
        return res;
      } catch (err) {
        console.warn('assistant fallback', err instanceof Error ? err.message : err);
        used.source = 'heuristic';
        return fallback.doGenerate(options);
      }
    },
    async doStream(options) {
      const deadline = Date.now() + AI_TIMEOUT_MS;
      let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;
      try {
        const res = await timeout(primary.doStream(options), AI_TIMEOUT_MS);
        reader = res.stream.getReader();
        const read = reader;
        const held: LanguageModelV4StreamPart[] = [];
        let finished = false;
        for (;;) {
          const { done, value } = await timeout(read.read(), Math.max(1, deadline - Date.now()));
          if (done) {
            finished = true;
            break;
          }
          if (value.type === 'error') throw value.error;
          held.push(value);
          if (CONTENT.has(value.type)) break;
        }
        if (finished && !held.some((p) => CONTENT.has(p.type))) throw new Error('empty answer');
        used.source = 'model';
        used.model = primary.modelId;
        // The finish part names the model that answered once the stream ends.
        const note = (p: LanguageModelV4StreamPart) => {
          if (p.type === 'finish') used.model = answeredBy(p.providerMetadata) ?? used.model;
          return p;
        };
        return {
          ...res,
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(c) {
              for (const p of held) c.enqueue(note(p));
              if (finished) c.close();
            },
            async pull(c) {
              if (finished) return;
              const { done, value } = await read.read();
              if (done) c.close();
              else c.enqueue(note(value));
            },
            cancel(reason) {
              return read.cancel(reason);
            },
          }),
        };
      } catch (err) {
        console.warn('assistant fallback', err instanceof Error ? err.message : err);
        // Stop paying for an answer nobody will read.
        reader?.cancel().catch(() => {});
        used.source = 'heuristic';
        return fallback.doStream(options);
      }
    },
  };
}

// ── The heuristic model ────────────────────────────────────────────────────

type Step = { tool: AssistantTool; input: Record<string, unknown> } | { text: string };

const ORDER_REF = /(?:#|\bord_)([a-z0-9]{4,})\b/i;
const EVENT = /\b([a-z]+\.[a-z_]+)\b/;
const CART_REF = /\bcart_[a-z0-9]+\b/i;

function lastUserText(prompt: LanguageModelV4Prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role === 'user')
      return m.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join(' ')
        .trim();
  }
  return '';
}

/** Picks one tool from the words used, or explains what it understands. */
export function heuristicStep(text: string, context: AssistantContext, tools: Set<string>): Step {
  const t = text.toLowerCase();
  const ref = ORDER_REF.exec(text);
  const orderId = ref
    ? ref[0].startsWith('#')
      ? ref[1]!
      : `ord_${ref[1]}`
    : context.kind === 'order'
      ? context.id
      : undefined;
  const flowId = context.kind === 'flow' ? context.id : undefined;
  const pick = (tool: AssistantTool, input: Record<string, unknown>): Step =>
    tools.has(tool)
      ? { tool, input }
      : {
          text: 'Your role can’t do that here. Ask an operator, or someone with the right role on the Team page.',
        };

  const cartId = CART_REF.exec(text)?.[0];
  if (cartId) return pick(/\bsubmit\b/.test(t) ? 'submit_cart' : 'get_cart', { cartId });
  if (/\bcarts\b/.test(t)) {
    const status = /\b(open|locked|submitted|canceled)\b/.exec(t)?.[1];
    return pick('list_carts', status ? { status } : {});
  }
  if (/\b(approve|reject|decline)\b/.test(t) && orderId)
    return pick('decide_approval', {
      orderId,
      decision: /\bapprove\b/.test(t) ? 'approved' : 'rejected',
    });
  if (/\bcancel\b/.test(t) && orderId)
    return pick('cancel_order', { orderId, reason: text.slice(0, 200) });
  const ev = EVENT.exec(t)?.[1];
  if (ev && orderId && /\b(deliver|mark|send|fire|record)\b/.test(t))
    return pick('deliver_event', { orderId, event: ev });
  if (/\bpublish\b/.test(t) && flowId) return pick('publish_flow', { flowId });
  if (/\b(run|start)\b.*\b(stock review|replenish|reorder)/.test(t))
    return pick('run_stock_review', {});
  if (flowId && /\b(add|insert|remove|delete|replace|change|move|rename|connect)\b/.test(t))
    return pick('propose_flow_change', { flowId, instruction: text });
  if (/\b(draft|write|make|build|create)\b.*\b(plugin|rule)\b/.test(t))
    return pick('draft_plugin', { instruction: text });
  if (/\b(needs? me|attention|waiting on|triage|stuck|overdue|what.*(should|do i|to do))\b/.test(t))
    return pick('needs_attention', {});
  if (/\b(stock|inventory|sku|reorder|low on)\b/.test(t)) {
    const sku = /\b([A-Z]{2,4}-\d{2,4})\b/i.exec(text)?.[1];
    return pick('find_products', {
      ...(sku ? { q: sku.toUpperCase() } : {}),
      belowReorder: /\b(low|reorder|below)\b/.test(t),
    });
  }
  if (/\bflows?\b/.test(t) && !flowId) return pick('list_flows', {});
  if (flowId && /\b(this flow|explain|what does|steps?)\b/.test(t))
    return pick('get_flow', { flowId });
  if (orderId && (ref || /\b(why|status|where|what|explain|this order|happen)\b/.test(t)))
    return pick('get_order', { orderId });
  if (/\b(orders?|show|find|list|how many|total)\b/.test(t)) {
    const input: Record<string, unknown> = {};
    const status =
      /\b(queued|running|waiting|completed|failed|cancelled|declined|rolled back)\b/.exec(t)?.[1];
    if (status) input.status = status.replace(' ', '_');
    const over = /\b(?:over|above|more than|>)\s*\$?([\d,.]+)\s*(k)?\b/.exec(t);
    if (over) input.minTotal = Number(over[1]!.replace(/,/g, '')) * (over[2] ? 1000 : 1);
    const under = /\b(?:under|below|less than|<)\s*\$?([\d,.]+)\s*(k)?\b/.exec(t);
    if (under) input.maxTotal = Number(under[1]!.replace(/,/g, '')) * (under[2] ? 1000 : 1);
    if (/\btoday\b/.test(t)) input.sinceDays = 1;
    else if (/\bthis week|last 7 days\b/.test(t)) input.sinceDays = 7;
    else if (/\bthis month|last 30 days\b/.test(t)) input.sinceDays = 30;
    const who = /\b(?:for|from|by)\s+([A-Z][\w&.-]+(?:\s[A-Z][\w&.-]+)*)/.exec(text)?.[1];
    if (who) input.customer = who;
    if (/\b(largest|biggest|top)\b/.test(t)) input.sort = 'largest';
    return pick('find_orders', input);
  }
  return {
    text: [
      'I’m answering without the language model right now, so I follow plain requests best:',
      '',
      '- “What needs me?”',
      '- “Waiting orders over $10k this week”',
      '- “Why is #a1b2c3 waiting?” or “Approve #a1b2c3”',
      '- “Which SKUs are low on stock?”',
      context.kind === 'flow' ? '- “Add a risk score after credit check”' : '- “List the flows”',
    ].join('\n'),
  };
}

/** People's words (a cart's title, a draft's explanation), kept out of a link's markup. */
const plain = (v: unknown) => String(v ?? '').replace(/[[\]()<>]/g, '');

/** A cart in one line: where it is, how far it got, and what still stops it. */
function describeCart(o: Record<string, unknown>) {
  const lines = Array.isArray(o.lines) ? o.lines.length : 0;
  return [
    `[${plain(o.id)}](${o.href}) ${plain(o.title)} is **${plain(o.status)}**: ${lines} line${lines === 1 ? '' : 's'}${o.priced && o.total ? `, ${o.total}` : ''}.`,
    o.orderId ? `It became [${orderRef(String(o.orderId))}](/orders/${o.orderId}).` : '',
    o.notReady && !o.orderId ? `Not ready to submit: ${plain(o.notReady)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Where an order is in its loop: the step it waits at or stopped at, else its status. */
function where(status: string, waitingAt?: string | null, stoppedAt?: string | null) {
  const s = status.replaceAll('_', ' ');
  if (waitingAt) return `waiting at ${waitingAt}`;
  return stoppedAt ? `${s} at ${stoppedAt}` : s;
}

/** One plain-language line per tool result, with links to what it found. */
export function describeResult(tool: string, output: unknown): string {
  const o = (output ?? {}) as Record<string, unknown>;
  const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  switch (tool) {
    case 'needs_attention': {
      const c = (o.counts ?? {}) as { approvals?: number; failed?: number; stalled?: number };
      const lines: string[] = [];
      for (const a of list<{ orderId: string; title: string }>(o.approvals))
        lines.push(`- ${a.title} on [${orderRef(a.orderId)}](/orders/${a.orderId})`);
      for (const f of list<{ id: string; title: string; status: string }>(o.failed))
        lines.push(
          `- [${orderRef(f.id)}](/orders/${f.id}) ${f.title ? `${f.title} ` : ''}${f.status.replace('_', ' ')}`,
        );
      for (const s of list<{ id: string; waitingOn: string | null }>(o.stalled))
        lines.push(
          `- [${orderRef(s.id)}](/orders/${s.id}) waiting on ${s.waitingOn ?? 'an event'} for over a day`,
        );
      if (!lines.length)
        return 'Nothing is waiting on anyone. No open approvals, recent failures or stalled orders.';
      return [
        `${c.approvals ?? 0} approval${c.approvals === 1 ? '' : 's'} open, ${c.failed ?? 0} failed in the last 3 days, ${c.stalled ?? 0} stalled.`,
        '',
        ...lines,
      ].join('\n');
    }
    case 'find_orders': {
      const rows = list<{
        ref: string;
        href: string;
        title: string;
        status: string;
        total: string;
        customer: string | null;
        waitingAt?: string | null;
        stoppedAt?: string | null;
      }>(o.orders);
      if (!rows.length) return 'No orders match that.';
      return [
        `${o.count} order${o.count === 1 ? '' : 's'}, ${o.total} in total${Number(o.count) > rows.length ? `; the first ${rows.length}` : ''}:`,
        '',
        ...rows.map(
          (r) =>
            `- [${r.ref}](${r.href}) ${r.title || r.customer || ''} · ${where(r.status, r.waitingAt, r.stoppedAt)} · ${r.total}`,
        ),
      ].join('\n');
    }
    case 'get_order': {
      const waits = list<{ title: string; kind: string; event?: string; step?: string }>(o.waits);
      const failed = list<{ step: string; status: string }>(o.steps).find(
        (x) => x.status === 'failed',
      );
      return [
        `[${o.ref}](${o.href}) ${o.title} is **${String(o.status).replaceAll('_', ' ')}**${failed && !waits.length ? ` at ${failed.step}` : ''}${o.reason ? `: ${o.reason}` : ''}. ${o.total}${o.customer ? ` for ${o.customer}` : ''}.`,
        waits.length
          ? `It waits at ${waits
              .map(
                (w) =>
                  `${w.step ?? w.title} for ${w.kind === 'approval' ? 'an approval' : `the event ${w.event}`}`,
              )
              .join(' and ')}.`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    }
    case 'assess_order': {
      const notes = list<string>(o.notes);
      return [
        `[${o.ref}](/orders/${o.id}): ${describeAnswers((o.answers ?? {}) as AssessAnswers)}${o.source === 'heuristic' ? ' (estimated without the model)' : ''}.`,
        ...notes.map((n) => `- Skipped ${n}`),
      ].join('\n');
    }
    case 'find_products': {
      const rows = list<{ sku: string; name: string; available: number; reorderPoint: number }>(
        o.products,
      );
      if (!rows.length) return 'No products match.';
      return rows
        .slice(0, 12)
        .map((p) => `- ${p.sku} ${p.name}: ${p.available} available (reorder at ${p.reorderPoint})`)
        .join('\n');
    }
    case 'list_carts': {
      const rows = list<{ id: string; href: string; title: string; status: string }>(o.carts);
      if (!rows.length) return 'No carts match that.';
      return rows
        .map((c) => `- [${plain(c.id)}](${c.href}) ${plain(c.title)} · ${plain(c.status)}`)
        .join('\n');
    }
    case 'get_cart':
    case 'create_cart':
      return describeCart(o);
    case 'change_cart':
      return `Made ${o.applied} change${o.applied === 1 ? '' : 's'}. ${describeCart(o)}`;
    case 'list_flows':
      return list<{ name: string; href: string; publishedVersion: number | null }>(o.flows)
        .map(
          (f) =>
            `- [${f.name}](${f.href}) ${f.publishedVersion ? `v${f.publishedVersion}` : 'not published'}`,
        )
        .join('\n');
    case 'get_flow':
      return `[${o.name}](${o.href}) has ${list(o.steps).length} steps${o.publishedVersion ? `; v${o.publishedVersion} is live` : ''}.${list(o.errors).length ? ` ${list(o.errors).length} problem(s) to fix.` : ''}`;
    case 'propose_flow_change':
      return `${o.explanation} Review it in the editor before applying.`;
    case 'draft_plugin': {
      const cases = (o.cases ?? {}) as { total?: number; passed?: number };
      return `Drafted [${plain(o.name)} version ${plain(o.version)}](${o.href}): ${plain(o.explanation)} ${cases.passed ?? 0} of ${cases.total ?? 0} test cases pass. Nothing runs until an admin reviews and approves it on the Plugins page.`;
    }
    default:
      return o.done ? `${o.done}.` : 'Done.';
  }
}

function lastToolResults(prompt: LanguageModelV4Prompt) {
  const last = prompt.at(-1);
  if (last?.role !== 'tool') return null;
  return last.content.flatMap((p) => (p.type === 'tool-result' ? [p] : []));
}

export function heuristicModel(context: AssistantContext): LanguageModelV4 {
  const answer = (options: LanguageModelV4CallOptions): Step => {
    const tools = new Set((options.tools ?? []).map((t) => t.name));
    const results = lastToolResults(options.prompt);
    if (results) {
      return {
        text: results
          .map((r) => {
            const out = r.output;
            if (out.type === 'execution-denied') return 'Left as it was. Nothing was sent.';
            if (out.type === 'error-text') return `That didn’t go through: ${out.value}`;
            if (out.type === 'error-json') return 'That didn’t go through.';
            return describeResult(
              r.toolName,
              out.type === 'json' ? out.value : out.type === 'text' ? out.value : null,
            );
          })
          .join('\n\n'),
      };
    }
    return heuristicStep(lastUserText(options.prompt), context, tools);
  };
  return {
    specificationVersion: 'v4',
    provider: 'orderloop',
    modelId: 'heuristic',
    supportedUrls: {},
    async doGenerate(options) {
      const step = answer(options);
      const call = 'tool' in step;
      return {
        content: call
          ? [
              {
                type: 'tool-call',
                toolCallId: crypto.randomUUID(),
                toolName: step.tool,
                input: JSON.stringify(step.input),
              },
            ]
          : [{ type: 'text', text: step.text }],
        finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream(options) {
      const step = answer(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if ('tool' in step) {
        parts.push({
          type: 'tool-call',
          toolCallId: crypto.randomUUID(),
          toolName: step.tool,
          input: JSON.stringify(step.input),
        });
      } else {
        parts.push(
          { type: 'text-start', id: 't0' },
          { type: 'text-delta', id: 't0', delta: step.text },
          { type: 'text-end', id: 't0' },
        );
      }
      parts.push({
        type: 'finish',
        usage: USAGE,
        finishReason: { unified: 'tool' in step ? 'tool-calls' : 'stop', raw: undefined },
      });
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}
