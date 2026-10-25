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
 * - Providers are dispatched by surface and op; every surface in `provides` needs a handler for
 *   each of its ops, and each gets the same `key` a node does.
 * - Pages get the person the web app signed onto the request, verified against both principal keys
 *   and checked against the manifest's `pageRole`; `publicPaths` get `principal: null`.
 * - The manifest call fails while a secret the manifest declares (and doesn't mark `optional`) is
 *   missing from env, so the engine leaves the plugin out and deep health names the secret.
 *
 * The contract itself is `PluginRpc` in @orderloop/core; see docs/plugins.md.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  atLeast,
  type CartReturn,
  type CartReturnRequest,
  type OutboundEvent,
  type OutboundPayload,
  PLUGIN_VIEW_TYPE,
  type PluginCompensateRequest,
  type PluginExecRequest,
  type PluginExecResult,
  type PluginHostRpc,
  type PluginManifest,
  type PluginRpc,
  type PluginView,
  PRINCIPAL_HEADER,
  PROVIDE_RESULT_SCHEMAS,
  type ProvideRequest,
  type ProvideResult,
  type ProviderSurface,
  type ProxiedPrincipal,
  parseManifest,
  type pluginManifestSchema,
  pluginSecretVar,
  verifyPrincipal,
} from '@orderloop/core';
import type { z } from 'zod';
import { hasSecret } from './runtime';

export {
  hasSecret,
  type PluginDatabase,
  pluginDb,
  type SecretsCapability,
  type StorageCapability,
  secret,
} from './runtime';

/**
 * What every plugin's environment carries: its own key the web app signs page requests with
 * (`pluginKey` in @orderloop/core, derived for this plugin alone), and the one before a rotation.
 * A plugin never holds the deployment's principal key.
 */
export type PluginEnv = {
  PLUGIN_KEY?: string;
  PLUGIN_KEY_PREVIOUS?: string;
  /** What it may ask of the core, as itself (`PluginHostRpc`); each method needs a granted capability. */
  ORDERLOOP?: PluginHostRpc;
};

/** The core's host binding, or a clear error where the deployment hasn't bound it. */
export function host(env: PluginEnv): PluginHostRpc {
  if (!env.ORDERLOOP)
    throw new Error('ORDERLOOP is not bound: this deployment gives the plugin no host API');
  return env.ORDERLOOP;
}

/**
 * A page drawn by the app: answer a page request with a view (`PluginView`) and the web app renders
 * it in its own shell and components, light and dark, instead of the plugin sending HTML. Links and
 * form actions are paths on the plugin's own pages, relative to them.
 */
export function viewResponse(view: PluginView, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', PLUGIN_VIEW_TYPE);
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(view), { ...init, headers });
}

export type { PluginView } from '@orderloop/core';

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

/** One provider op's request, by surface and op. */
export type ProvideFor<S extends ProviderSurface, O extends string> = Extract<
  ProvideRequest,
  { surface: S; op: O }
>;

export type ProviderContext<E, R> = {
  req: R;
  env: E;
  /** `<orderId>:<stepKey>`, as a node's: write by it. */
  key: string;
  fail(message: string, opts?: { retry?: boolean }): { fail: { message: string; retry: boolean } };
};

type Op<E, S extends ProviderSurface, O extends string> = (
  ctx: ProviderContext<E, ProvideFor<S, O>>,
) => ProvideResult<S, O> | Promise<ProvideResult<S, O>>;

/** Handlers for each surface the manifest `provides`, one per op. */
export type ProviderHandlers<E> = {
  'shipping.rates'?: { quote: Op<E, 'shipping.rates', 'quote'> };
  'shipping.labels'?: {
    create: Op<E, 'shipping.labels', 'create'>;
    /** Voids what `create` made for the same key; safe to repeat. */
    void: Op<E, 'shipping.labels', 'void'>;
  };
  tax?: { calculate: Op<E, 'tax', 'calculate'> };
  address?: { validate: Op<E, 'address', 'validate'> };
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
  providers?: ProviderHandlers<E>;
  /**
   * With the `carts:external` capability: the form fields that return a cart this plugin opened
   * to the buyer's system. Called once per return; the core posts them to the cart's `returnUrl`.
   */
  renderReturn?(req: CartReturnRequest, env: E): CartReturn | Promise<CartReturn>;
};

/** The ops each surface has. */
const opsOf = (surface: ProviderSurface) => Object.keys(PROVIDE_RESULT_SCHEMAS[surface]);

/** The declared secrets, not `optional`, that aren't set, wherever this runtime keeps them. */
export async function missingSecrets(manifest: PluginManifest, env: object): Promise<string[]> {
  const set = await Promise.all(
    manifest.secrets.map(async (s) => s.optional || (await hasSecret(env, s.name))),
  );
  return manifest.secrets.filter((_, i) => !set[i]).map((s) => s.name);
}

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
  const handled = Object.keys(def.events ?? {});
  for (const event of handled)
    if (!subscribed.has('*') && !subscribed.has(event))
      problems.push(`events.${event} is not in the manifest's events`);
  for (const event of subscribed)
    if (event !== '*' && !handled.includes(event))
      problems.push(`the manifest subscribes to ${event} but events has no handler for it`);
  const providers = (def.providers ?? {}) as Record<string, Record<string, unknown> | undefined>;
  for (const surface of manifest.provides)
    for (const op of opsOf(surface))
      if (typeof providers[surface]?.[op] !== 'function')
        problems.push(`the manifest provides ${surface} but providers has no ${surface}.${op}`);
  for (const surface of Object.keys(providers))
    if (!(manifest.provides as string[]).includes(surface))
      problems.push(`providers.${surface} is not in the manifest's provides`);
  if (manifest.capabilities.includes('carts:external') && !def.renderReturn)
    problems.push('the manifest asks for carts:external but there is no renderReturn handler');
  if (def.renderReturn && !manifest.capabilities.includes('carts:external'))
    problems.push('renderReturn is set but the manifest does not ask for carts:external');
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
      const missing = await missingSecrets(manifest, this.env);
      if (missing.length)
        throw new Error(
          `${manifest.id} is missing ${missing.length === 1 ? 'a secret' : 'secrets'}: set ${missing
            .map((n) => pluginSecretVar(manifest.id, n))
            .join(', ')} in the deployment's GitHub environment`,
        );
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
      // A node this version no longer handles can't be undone here; saying so keeps the order
      // from reading as rolled back while its effect stays.
      if (!h) throw new Error(`${req.type} is not a node of ${manifest.id}, so it can't be undone`);
      const said = await h.compensate?.({
        req,
        env: this.env,
        key: runKey(req.orderId, req.stepKey),
      });
      return said ?? 'Nothing to undo';
    }

    async provide(req: ProvideRequest): Promise<ProvideResult> {
      const handlers = def.providers as
        | Record<string, Record<string, Op<E, ProviderSurface, string>> | undefined>
        | undefined;
      const h = manifest.provides.includes(req.surface)
        ? handlers?.[req.surface]?.[req.op]
        : undefined;
      if (!h)
        return { fail: { message: `${manifest.id} doesn't provide ${req.surface} ${req.op}` } };
      return h({
        req: req as never,
        env: this.env,
        key: runKey(req.orderId, req.stepKey),
        fail: (message, opts) => ({ fail: { message, retry: opts?.retry === true } }),
      });
    }

    async renderReturn(req: CartReturnRequest): Promise<CartReturn> {
      if (!def.renderReturn) throw new Error(`${manifest.id} doesn't return carts`);
      return def.renderReturn(req, this.env);
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
        [this.env.PLUGIN_KEY, this.env.PLUGIN_KEY_PREVIOUS],
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
