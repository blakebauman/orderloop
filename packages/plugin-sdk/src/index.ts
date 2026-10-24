/**
 * definePlugin: a plugin's whole `PluginRpc` entrypoint from its manifest and handlers, with the
 * parts that are easy to get wrong done once, here:
 *
 * - The manifest is checked when the Worker loads (`parseManifest`), and so is the match between
 *   its nodes and the handlers given: a node without a handler, a handler without a node, or a
 *   rollback node without `compensate` fails the deploy rather than an order.
 * - Each node handler gets `key`, the one key to write by (the order id and the step key together),
 *   and `fail()` for failing the node.
 * - Events are dispatched by name; an event without a handler is ignored.
 * - Pages get the person the web app signed onto the request, verified against both principal keys
 *   and checked against the manifest's `pageRole`; `publicPaths` get `principal: null`.
 *
 * The contract itself is `PluginRpc` in @orderloop/core; see docs/plugins.md.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  atLeast,
  type OutboundEvent,
  type OutboundPayload,
  type PluginCompensateRequest,
  type PluginExecRequest,
  type PluginExecResult,
  type PluginManifest,
  type PluginRpc,
  PRINCIPAL_HEADER,
  type ProxiedPrincipal,
  parseManifest,
  type pluginManifestSchema,
  verifyPrincipal,
} from '@orderloop/core';
import type { z } from 'zod';

/** What every plugin's environment carries: the keys the web app signs page requests with. */
export type PluginEnv = { PRINCIPAL_KEY?: string; PRINCIPAL_KEY_PREVIOUS?: string };

/** A manifest as written: defaults may be left out. */
export type ManifestInput = z.input<typeof pluginManifestSchema>;

export type NodeContext<E> = {
  req: PluginExecRequest;
  env: E;
  /** `<orderId>:<stepKey>`: the same on every retry of this run, unique across runs. Write by it. */
  key: string;
  /** The result that fails the node: for good by default, or tried again with `retry: true`. */
  fail(message: string, opts?: { retry?: boolean }): PluginExecResult;
};

export type CompensateContext<E> = {
  req: PluginCompensateRequest;
  env: E;
  /** The same `key` its `execute` wrote by. */
  key: string;
};

export type NodeHandler<E> = {
  execute(ctx: NodeContext<E>): PluginExecResult | Promise<PluginExecResult>;
  /** Required for a node with `rollback`. Undoes what `execute` did for `key`; safe to repeat. */
  compensate?(ctx: CompensateContext<E>): string | undefined | Promise<string | undefined>;
};

export type PageContext<E> = {
  env: E;
  /** The verified person, or null on a public path. */
  principal: ProxiedPrincipal | null;
};

export type PluginDefinition<E> = {
  manifest: ManifestInput;
  /** By node name: `stamp` for `example.stamp`. */
  nodes?: Record<string, NodeHandler<E>>;
  /** By event name. Each runs at least once per delivery: key what it writes by `payload.id`. */
  events?: Partial<
    Record<OutboundEvent, (payload: OutboundPayload, env: E) => Promise<void> | void>
  >;
  pages?(request: Request, ctx: PageContext<E>): Response | Promise<Response>;
};

/** The writes key for one node run. */
export const runKey = (orderId: string, stepKey: string) => `${orderId}:${stepKey}`;

/** Checks a definition: the manifest, and that its nodes and handlers match. Throws on a mismatch. */
export function checkDefinition<E>(def: PluginDefinition<E>): PluginManifest {
  const manifest = parseManifest(def.manifest);
  const handlers = def.nodes ?? {};
  const problems: string[] = [];
  for (const n of manifest.nodes) {
    const h = handlers[n.type.slice(manifest.id.length + 1)];
    if (!h) problems.push(`${n.type} has no handler in nodes`);
    else if (n.rollback && !h.compensate) problems.push(`${n.type} has rollback but no compensate`);
  }
  for (const name of Object.keys(handlers))
    if (!manifest.nodes.some((n) => n.type === `${manifest.id}.${name}`))
      problems.push(`nodes.${name} is not a node in the manifest`);
  const subscribed = new Set<string>(manifest.events);
  for (const event of Object.keys(def.events ?? {}))
    if (!subscribed.has('*') && !subscribed.has(event))
      problems.push(`events.${event} is not in the manifest's events`);
  if ((manifest.nav.length || manifest.publicPaths.length) && !def.pages)
    problems.push('the manifest has pages (nav or publicPaths) but there is no pages handler');
  if (problems.length) throw new Error(`Plugin ${manifest.id}: ${problems.join('; ')}`);
  return manifest;
}

/** The plugin's default entrypoint class. Export it as the Worker's default. */
export function definePlugin<E extends PluginEnv>(def: PluginDefinition<E>) {
  const manifest = checkDefinition(def);
  const prefix = `${manifest.id}.`;
  const handler = (type: string) =>
    type.startsWith(prefix) ? def.nodes?.[type.slice(prefix.length)] : undefined;

  return class Plugin extends WorkerEntrypoint<E> implements PluginRpc {
    async manifest() {
      return manifest;
    }

    async execute(req: PluginExecRequest): Promise<PluginExecResult> {
      const h = handler(req.type);
      if (!h) return { fail: { message: `${req.type} is not a node of ${manifest.id}` } };
      return h.execute({
        req,
        env: this.env,
        key: runKey(req.orderId, req.stepKey),
        fail: (message, opts) => ({ fail: { message, retry: opts?.retry === true } }),
      });
    }

    async compensate(req: PluginCompensateRequest) {
      const h = handler(req.type);
      const said = await h?.compensate?.({
        req,
        env: this.env,
        key: runKey(req.orderId, req.stepKey),
      });
      return said ?? 'Nothing to undo';
    }

    async deliver(payload: OutboundPayload) {
      await def.events?.[payload.event]?.(payload, this.env);
    }

    override async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (!def.pages) return new Response('Not found', { status: 404 });
      if (manifest.publicPaths.includes(path))
        return def.pages(request, { env: this.env, principal: null });
      const principal = await verifyPrincipal(
        [this.env.PRINCIPAL_KEY, this.env.PRINCIPAL_KEY_PREVIOUS],
        request.headers.get(PRINCIPAL_HEADER),
        path,
      );
      if (!principal) return new Response('Unauthorized', { status: 401 });
      if (!atLeast(principal.role, manifest.pageRole))
        return new Response('Forbidden', { status: 403 });
      return def.pages(request, { env: this.env, principal });
    }
  };
}
