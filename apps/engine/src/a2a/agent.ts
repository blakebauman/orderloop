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
import { TaskNotCancelableError } from '@a2a-js/sdk/errors';
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
} from '@a2a-js/sdk/server';
import {
  A2A_PROTOCOL_VERSION,
  agentCard,
  decodePrincipal,
  PRINCIPAL_HEADER,
} from '@orderloop/core';
import { Refused } from '../assistant/data';
import { runTool } from '../assistant/tools';
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
    this.transport = new JsonRpcTransportHandler(
      new A2AHandler(env, this.store, new OrderLoopExecutor(env, this.store), pushStore, this.push),
    );
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
    const proxied = decodePrincipal(request.headers.get(PRINCIPAL_HEADER));
    if (!proxied) return new Response('Unauthorized', { status: 401 });
    const { session: _session, ...principal } = proxied;
    const body = await request.text();

    // No header means a 1.0 client that didn't say; anything else must be a version we speak.
    const version = request.headers.get('a2a-version') || A2A_PROTOCOL_VERSION;
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
    const result = await this.transport.handle(body, context);
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

function rpcId(body: string): string | number | null {
  try {
    const id = (JSON.parse(body) as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}
