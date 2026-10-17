/**
 * A2AAgent: OrderLoop's A2A endpoint (JSON-RPC at `/a2a`), one Durable Object per caller. The web
 * Worker authenticates the caller (an OAuth grant for `/a2a`, or an `ol_live_` API token) and
 * forwards here with the principal header; api.ts names the object after the principal, so a
 * caller only ever sees their own tasks. Tasks live in this object's SQLite (store.ts), and a
 * streaming request and a SubscribeToTask for the same task share one event bus because they run
 * in the same object.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  AgentCard,
  type CancelTaskRequest,
  formatSSEErrorEvent,
  formatSSEEvent,
  SSE_HEADERS,
  type Task,
} from '@a2a-js/sdk';
import { isLegacyJsonRpcMethod } from '@a2a-js/sdk/compat/v0_3';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import { TaskNotCancelableError } from '@a2a-js/sdk/errors';
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
} from '@a2a-js/sdk/server';
import { A2A_LEGACY_PROTOCOL_VERSION, A2A_PROTOCOL_VERSION, agentCard } from '@orderloop/core';
import { Refused } from '../assistant/data';
import { runTool } from '../assistant/tools';
import { forwardedPrincipal } from '../principal';
import { OrderLoopExecutor, PrincipalUser, principalOf } from './executor';
import { PushSender, SqlPushStore } from './push';
import { isTerminal, SqlTaskStore } from './store';

// The handler reads the card only for capabilities and input modes; the public card, with this
// origin's URLs, is the web Worker's (/.well-known/agent-card.json).
const CARD = AgentCard.fromJSON(agentCard('https://orderloop.invalid'));

/** Cancelling a task that follows an order cancels the order, as the caller, first. */
class A2AHandler extends DefaultRequestHandler {
  constructor(
    private readonly env: Env,
    private readonly store: SqlTaskStore,
    executor: OrderLoopExecutor,
    pushStore: SqlPushStore,
    push: PushSender,
  ) {
    super(CARD, store, executor, new DefaultExecutionEventBusManager(), pushStore, push);
  }

  override async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const orderId = this.store.orderOf(params.id);
    const task = await this.store.load(params.id);
    if (orderId && task && !isTerminal(task)) {
      try {
        await runTool(
          this.env,
          principalOf(context),
          'cancel_order',
          { orderId, reason: 'Cancelled over A2A' },
          { via: 'A2A' },
        );
      } catch (err) {
        if (err instanceof Refused) throw new TaskNotCancelableError(err.message);
        throw err;
      }
    }
    return super.cancelTask(params, context);
  }
}

export class A2AAgent extends DurableObject<Env> {
  private readonly transport: JsonRpcTransportHandler;
  private readonly legacy: LegacyJsonRpcTransportHandler;
  private readonly store: SqlTaskStore;
  private readonly push: PushSender;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // route.ts reaches this object by name (getByName), so the id carries it.
    const name = ctx.id.name;
    if (!name) throw new Error('A2AAgent must be addressed by name');
    this.store = new SqlTaskStore(ctx.storage.sql, env, name);
    const pushStore = new SqlPushStore(ctx.storage.sql);
    this.push = new PushSender(ctx.storage, pushStore);
    const handler = new A2AHandler(
      env,
      this.store,
      new OrderLoopExecutor(env, this.store),
      pushStore,
      this.push,
    );
    this.transport = new JsonRpcTransportHandler(handler);
    this.legacy = new LegacyJsonRpcTransportHandler(handler);
  }

  /**
   * An order this caller's tasks follow has moved (OrderAgent.notifyWatchers). Each task it
   * changed is pushed as a status update; a task already showing that state sends nothing, so a
   * repeated call is harmless.
   */
  async orderChanged(orderId: string): Promise<void> {
    for (const { task, changed } of await this.store.following(orderId)) {
      if (!changed || !task.status) continue;
      await this.push.send(
        {
          payload: {
            $case: 'statusUpdate',
            value: {
              taskId: task.id,
              contextId: task.contextId,
              status: task.status,
              metadata: undefined,
            },
          },
        },
        undefined,
        task,
      );
    }
  }

  /** Retries push notifications that are due. */
  override async alarm(): Promise<void> {
    await this.push.deliver();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('A2A takes JSON-RPC over POST', {
        status: 405,
        headers: { allow: 'POST' },
      });
    const proxied = await forwardedPrincipal(this.env, request);
    if (!proxied) return new Response('Unauthorized', { status: 401 });
    const { session: _session, ...principal } = proxied;
    const body = await request.text();

    // A 0.3 client is known by its method names (message/send, tasks/get, …); the SDK's 0.3
    // transport translates them to the same handler. Anyone else must speak a version we do; no
    // header with 1.0 method names is a 1.0 client that didn't say.
    const legacy = isLegacyJsonRpcMethod(rpcMethod(body));
    const version = legacy
      ? A2A_LEGACY_PROTOCOL_VERSION
      : request.headers.get('a2a-version') || A2A_PROTOCOL_VERSION;
    if (!legacy)
      try {
        validateVersion(version, CARD);
      } catch (err) {
        return Response.json({
          jsonrpc: '2.0',
          id: rpcId(body),
          error: JsonRpcTransportHandler.mapToJSONRPCError(err),
        });
      }

    const context = new ServerCallContext({
      user: new PrincipalUser(principal),
      requestedVersion: version,
    });
    const result = await (legacy ? this.legacy : this.transport).handle(body, context);
    if (!(Symbol.asyncIterator in result)) return Response.json(result);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of result)
            controller.enqueue(encoder.encode(formatSSEEvent(event)));
        } catch (err) {
          console.error('a2a: stream failed', err);
          controller.enqueue(encoder.encode(formatSSEErrorEvent(err)));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }
}

function rpcMethod(body: string): unknown {
  try {
    return (JSON.parse(body) as { method?: unknown }).method;
  } catch {
    return undefined;
  }
}

function rpcId(body: string): string | number | null {
  try {
    const id = (JSON.parse(body) as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}
