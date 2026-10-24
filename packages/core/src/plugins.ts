/**
 * Plugins: optional features a deployment installs as their own Worker, bound to the engine and the
 * web app as `PLUGIN_<ID>`. A plugin owns its storage and reaches OrderLoop only through this
 * contract, so removing it (from the deployment registry, then its Worker and database) leaves the
 * core as it was. See docs/plugins.md.
 *
 * A plugin contributes node types (namespaced `<id>.<name>`, run by the engine inside the node's
 * own step), subscribes to outbound events (delivered over the binding instead of HTTP) and serves
 * pages under `/plugins/<id>/`. Its manifest is plain JSON, so node specs are the serialisable
 * subset of `NodeSpec`: fixed outputs and JSON Schema in place of zod.
 */

import { z } from 'zod';
import {
  type ConfigField,
  type NodeCategory,
  type NodeSpec,
  nodeOutputs,
  nodeSpec,
  specDefaults,
  validateFields,
} from './catalog';
import { conforms } from './json-schema';
import { maskPersonalText, modelOrder, PERSONAL_DATA_MODES, scrubPersonal } from './redact';
import { ROLES } from './roles';
import type { Order } from './types';
import { OUTBOUND_EVENTS, type OutboundPayload } from './webhooks';

/** Node type prefixes the built-in catalog uses; no plugin may take one as its id. */
const RESERVED_IDS = new Set(['trigger', 'commerce', 'control', 'ai', 'core', 'orderloop']);

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * The contract version this OrderLoop speaks. A manifest declares the one it was written for, and
 * one for any other version is refused rather than half understood.
 */
export const PLUGIN_API_VERSION = 1;

/** Longest summary a plugin node may report for the order's timeline. */
export const PLUGIN_SUMMARY_MAX = 300;

/** Largest `output` (and, separately, `vars`) a plugin node may return, serialized. */
export const PLUGIN_RESULT_MAX_BYTES = 128 * 1024;

/** Largest manifest the engine accepts, serialized. */
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;

/** A nav or public path: plain characters only, so a link can't lead outside the plugin. */
const PLUGIN_PAGE_PATH_RE = /^\/plugins\/[a-z][a-z0-9-]{1,30}\/[A-Za-z0-9._~/-]*$/;

/**
 * The key the web app signs a plugin's page requests with, and the only one the plugin holds: an
 * HMAC of the deployment's principal key with the plugin's id. The engine and other plugins never
 * accept it, so a plugin can't sign requests to them; scripts/fleet.ts derives the same value for
 * the plugin's secrets.
 */
export async function pluginKey(principalKey: string, id: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(principalKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`orderloop-plugin:${id}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The binding a plugin is reached by: "ledger" → "PLUGIN_LEDGER", "qbd-sync" → "PLUGIN_QBD_SYNC". */
export const pluginBinding = (id: string) => `PLUGIN_${id.toUpperCase().replace(/-/g, '_')}`;

/** A secret's name in the plugin's env: upper case, digits and underscores. */
export const PLUGIN_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

/** Names a plugin's env already has from the deployment, which no secret may take. */
export const RESERVED_PLUGIN_ENV = new Set(['PLUGIN_KEY', 'PLUGIN_KEY_PREVIOUS', 'DB']);

/**
 * Where a deployment keeps one of a plugin's secrets: in its GitHub environment, named by the
 * plugin's binding and the secret ("shipstation", "API_KEY" → "PLUGIN_SHIPSTATION_API_KEY"). The
 * deploy hands the plugin's Worker only the ones with its prefix, under their own names.
 */
export const pluginSecretVar = (id: string, name: string) => `${pluginBinding(id)}_${name}`;

/** The plugin a node type belongs to, or null for a built-in type. */
export function pluginOf(type: string): string | null {
  const dot = type.indexOf('.');
  if (dot < 1) return null;
  const ns = type.slice(0, dot);
  return RESERVED_IDS.has(ns) ? null : ns;
}

const pluginId = z
  .string()
  .regex(PLUGIN_ID_RE, 'Use 2–31 lowercase letters, digits and hyphens, starting with a letter')
  .refine((id) => !RESERVED_IDS.has(id), 'That id is reserved');

const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum([
    'text',
    'textarea',
    'number',
    'boolean',
    'select',
    'duration',
    'logic',
    'json',
    'list',
  ]),
  hint: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  /** Validates a `json` field's value, in place of the zod schema a built-in field can carry. */
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
});

export type PluginField = z.infer<typeof fieldSchema>;

const nodeSchema = z.object({
  type: z.string(),
  /** Plugin nodes run in one step: no triggers, and no waiting or looping (the interpreter's own). */
  category: z.enum(['commerce', 'control', 'ai']),
  label: z.string().min(1),
  description: z.string(),
  /** lucide-react icon name. */
  icon: z.string().min(1),
  fields: z.array(fieldSchema).max(50),
  outputs: z.array(z.string().min(1)).min(1),
  /** The plugin's `compensate` runs for this node when the order fails after it. */
  rollback: z.boolean().optional(),
  retries: z.number().int().min(0).max(10).optional(),
});

export type PluginNodeSpec = z.infer<typeof nodeSchema>;

export const pluginManifestSchema = z
  .object({
    /** Must be `PLUGIN_API_VERSION`. */
    apiVersion: z.literal(PLUGIN_API_VERSION, {
      error: `apiVersion must be ${PLUGIN_API_VERSION}, the plugin contract this OrderLoop speaks`,
    }),
    id: pluginId,
    name: z.string().min(1),
    /** Changes whenever the manifest does; the engine caches manifests by it. */
    version: z.string().min(1),
    nodes: z.array(nodeSchema).max(50).default([]),
    /** Outbound events delivered to the plugin's `deliver`; "*" for every one. */
    events: z.array(z.enum(['*', ...OUTBOUND_EVENTS])).default([]),
    /** Sidebar entries; each path is under the plugin's own `/plugins/<id>/`. */
    nav: z
      .array(z.object({ label: z.string().min(1), path: z.string(), icon: z.string().min(1) }))
      .default([]),
    /**
     * Paths under `/plugins/<id>/` the web app forwards with no signed-in person, for callers that
     * authenticate to the plugin themselves (another system's connector, a webhook).
     */
    publicPaths: z.array(z.string()).default([]),
    /** Plugins that must be installed alongside this one. */
    requires: z.array(pluginId).default([]),
    /** The least role a person needs to open the plugin's pages (and see its nav entries). */
    pageRole: z.enum(ROLES).default('operator'),
    /**
     * Whether `execute` sees who the buyer is. `redact` (the default) scrubs contact details, names
     * and addresses from the order, variables and earlier outputs it is sent, as AI nodes get them.
     */
    personalData: z.enum(PERSONAL_DATA_MODES).default('redact'),
    /**
     * Secrets the plugin reads from its env (an outside service's API key, a webhook signing
     * secret), set per deployment as `pluginSecretVar(id, name)`. Until each one not `optional` is
     * set, the plugin's manifest call fails, so the plugin counts as not installed.
     */
    secrets: z
      .array(
        z.object({
          name: z
            .string()
            .regex(PLUGIN_SECRET_NAME_RE, 'Use upper-case letters, digits and underscores'),
          description: z.string().max(200).optional(),
          optional: z.boolean().optional(),
        }),
      )
      .max(20)
      .default([]),
  })
  .superRefine((m, ctx) => {
    const prefix = `/plugins/${m.id}/`;
    const seen = new Set<string>();
    for (const [i, n] of m.nodes.entries()) {
      const name = n.type.slice(m.id.length + 1);
      if (!n.type.startsWith(`${m.id}.`) || !/^[a-z][a-z0-9_]*$/.test(name))
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', i, 'type'],
          message: `Node types must be “${m.id}.<name>” (lowercase, digits, underscores)`,
        });
      if (seen.has(n.type))
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'type'], message: 'Duplicate type' });
      seen.add(n.type);
    }
    const names = new Set<string>();
    for (const [i, { name }] of m.secrets.entries()) {
      if (RESERVED_PLUGIN_ENV.has(name) || names.has(name))
        ctx.addIssue({
          code: 'custom',
          path: ['secrets', i, 'name'],
          message: RESERVED_PLUGIN_ENV.has(name) ? 'That name is reserved' : 'Duplicate secret',
        });
      names.add(name);
    }
    for (const [key, paths] of [
      ['nav', m.nav.map((n) => n.path)],
      ['publicPaths', m.publicPaths],
    ] as const)
      for (const [i, p] of paths.entries())
        if (!p.startsWith(prefix) || !PLUGIN_PAGE_PATH_RE.test(p) || /(^|\/)\.\.?(\/|$)/.test(p))
          ctx.addIssue({
            code: 'custom',
            path: [key, i],
            message: `Must be a plain path under ${prefix} (letters, digits, - _ . ~ /, no . or .. segments)`,
          });
    let bytes = 0;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(m)).byteLength;
    } catch {}
    if (bytes > PLUGIN_MANIFEST_MAX_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: `The manifest is ${bytes} bytes; the limit is ${PLUGIN_MANIFEST_MAX_BYTES}`,
      });
  });

export type PluginManifest = z.output<typeof pluginManifestSchema>;

/** Parses a manifest a plugin returned, with its problems as one readable error. */
export function parseManifest(value: unknown): PluginManifest {
  const r = pluginManifestSchema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new Error(
    `Invalid plugin manifest: ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
  );
}

/** What the engine sends a plugin to run one of its nodes, inside that node's step. */
export type PluginExecRequest = {
  type: string;
  nodeId: string;
  /**
   * The node's effect key, unique within the order: key every write for this run by `orderId` and
   * `stepKey` together, so a retried step writes once.
   */
  stepKey: string;
  orderId: string;
  /** The node's config with defaults filled in, expressions not yet evaluated. */
  config: Record<string, unknown>;
  /** The whole order with `personalData: 'send'`; otherwise `RedactedOrder` (see `pluginOrder`). */
  order: Order | RedactedOrder;
  vars: Record<string, unknown>;
  /** Earlier nodes' outputs, by node id. */
  nodes: Record<string, unknown>;
};

/**
 * What `execute` returns: the branch it took, or `fail` to fail the node. `fail` with `retry: false`
 * fails it for good (a declined request, bad config); with `retry: true` the step is tried again,
 * as when `execute` throws.
 */
export type PluginExecResult =
  | {
      /** One of the node's `outputs`; defaults to the first. */
      branch?: string;
      output?: unknown;
      /** One line for the order's timeline, at most `PLUGIN_SUMMARY_MAX` characters. */
      summary?: string;
      /** Merged into the order's variables under the plugin's id: `vars.<id>`. */
      vars?: Record<string, unknown>;
    }
  | { fail: { message: string; retry?: boolean } };

const jsonSized = (what: string) =>
  z.unknown().superRefine((v, ctx) => {
    let bytes: number;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(v ?? null)).byteLength;
    } catch {
      ctx.addIssue({ code: 'custom', message: `${what} must be JSON` });
      return;
    }
    if (bytes > PLUGIN_RESULT_MAX_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: `${what} is ${bytes} bytes; the limit is ${PLUGIN_RESULT_MAX_BYTES}`,
      });
  });

/** Long text is cut, not refused: a long upstream error must not turn a retry into a failure. */
const clip = (s: string) =>
  s.length > PLUGIN_SUMMARY_MAX ? `${s.slice(0, PLUGIN_SUMMARY_MAX - 1)}…` : s;

const failSchema = z.object({
  fail: z.object({
    message: z.string().min(1).transform(clip),
    retry: z.boolean().optional(),
  }),
});

const doneSchema = z.object({
  branch: z.string().optional(),
  output: jsonSized('output').optional(),
  summary: z.string().transform(clip).optional(),
  vars: z.record(z.string(), z.unknown()).and(jsonSized('vars')).optional(),
});

/** A checked `execute` result: what the node did, or how it failed. */
export type PluginOutcome =
  | {
      kind: 'done';
      branch: string;
      output?: unknown;
      summary?: string;
      vars?: Record<string, unknown>;
    }
  | { kind: 'fail'; message: string; retry: boolean };

/**
 * Checks what a plugin returned for a node with these `outputs`. Throws (with a message naming the
 * problem) for a result the engine must not apply: not the contract's shape, too large, or a
 * branch the node doesn't have.
 */
export function checkExecResult(type: string, value: unknown, outputs: string[]): PluginOutcome {
  const raw = value ?? {};
  const failing = !!raw && typeof raw === 'object' && 'fail' in raw;
  const r = (failing ? failSchema : doneSchema).safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(
      `${type} returned an invalid result: ${issue?.path.join('.') || 'result'}: ${issue?.message}`,
    );
  }
  if ('fail' in r.data)
    return { kind: 'fail', message: r.data.fail.message, retry: r.data.fail.retry === true };
  const branch = r.data.branch ?? outputs[0]!;
  if (!outputs.includes(branch))
    throw new Error(`${type} chose “${branch}”, which isn't one of its outputs`);
  return {
    kind: 'done',
    branch,
    output: r.data.output,
    summary: r.data.summary,
    vars: r.data.vars,
  };
}

type Privacy = Pick<PluginManifest, 'personalData'>;

/** Variables or earlier outputs as a plugin with this manifest is sent them. */
export function pluginView<T>(manifest: Privacy, value: T): T {
  return manifest.personalData === 'send' ? value : (scrubPersonal(value) as T);
}

/** The order as a plugin that hasn't been granted buyer details sees it. */
export type RedactedOrder = ReturnType<typeof modelOrder> & {
  externalId?: string;
  createdAt: number;
};

/**
 * The order as a plugin with this manifest is sent it. Redacted, it is built from an allowlist of
 * commercial facts, as AI nodes get it: lines (with product names), amounts, currency, channel,
 * fulfilment method and ship-to country; the title with emails and phone numbers masked. It has no
 * contact, addresses, `meta`, inbound document text or payment ids.
 */
export function pluginOrder(manifest: Privacy, order: Order): Order | RedactedOrder {
  if (manifest.personalData === 'send') return order;
  const { meta: _meta, ...facts } = modelOrder(order, 'redact');
  return {
    ...facts,
    title: order.title ? maskPersonalText(order.title) : undefined,
    externalId: order.externalId,
    createdAt: order.createdAt,
  } as RedactedOrder;
}

export type PluginCompensateRequest = {
  type: string;
  nodeId: string;
  stepKey: string;
  orderId: string;
  /** What `execute` returned as `output` for this run, when it got that far. */
  output: unknown;
};

/**
 * The RPC every plugin Worker's default entrypoint implements. `fetch` serves its pages: a request
 * under `/plugins/<id>/` arrives with the signed principal header (`verifyPrincipal`), except on the
 * manifest's `publicPaths`.
 */
export interface PluginRpc {
  manifest(): Promise<PluginManifest>;
  execute(req: PluginExecRequest): Promise<PluginExecResult>;
  /** Undoes `execute`. Idempotent: it may run more than once for the same step key. */
  compensate(req: PluginCompensateRequest): Promise<string>;
  /** An outbound event. Idempotent on `payload.id`, which is stable across redeliveries. */
  deliver(payload: OutboundPayload): Promise<void>;
}

/**
 * One `PLUGIN_*` binding as the engine sees it. `manifest` is what the deployment runs: null when
 * the plugin is refused (its manifest doesn't parse, its id doesn't match the binding, a plugin it
 * requires is missing), and the last good one while the plugin is unreachable. `healthy` is whether
 * the plugin answered with a usable manifest just now.
 */
export type PluginStatus = {
  binding: string;
  manifest: PluginManifest | null;
  healthy: boolean;
  error?: string;
};

/** What still uses a plugin's nodes; it can be removed only once both lists are empty. */
export type PluginUsage = {
  /** Flows whose published version uses the plugin's nodes. */
  flows: { id: string; version: number }[];
  /** Orders still running on a flow version that does. */
  orders: { id: string; flowId: string; version: number }[];
};

// ── Node registry ────────────────────────────────────────────────────────────

/** Node lookups for a set of installed plugins: the built-in catalog plus each plugin's nodes. */
export type NodeRegistry = {
  spec(type: string): NodeSpec | undefined;
  outputs(type: string, config?: Record<string, unknown>): string[];
  withDefaults(type: string, config?: Record<string, unknown>): Record<string, unknown>;
  validate(type: string, config: Record<string, unknown>): string[];
  /** The installed plugins' node specs, for the palette. */
  pluginNodes(): { plugin: PluginManifest; spec: NodeSpec }[];
  /** Ids of the installed plugins. */
  installed(): string[];
};

function toNodeSpec(n: PluginNodeSpec): NodeSpec {
  const fields: ConfigField[] = n.fields.map(({ jsonSchema, ...f }) => ({
    ...f,
    ...(jsonSchema
      ? {
          schema: z
            .unknown()
            .refine((v) => conforms(v, jsonSchema), "Doesn't match the expected shape"),
        }
      : {}),
  }));
  return {
    type: n.type,
    category: n.category as NodeCategory,
    label: n.label,
    description: n.description,
    icon: n.icon,
    fields,
    outputs: n.outputs,
    rollback: n.rollback,
    retries: n.retries,
  };
}

/** The registry for these installed plugins' manifests. */
export function withPlugins(manifests: readonly PluginManifest[]): NodeRegistry {
  const byType = new Map<string, { plugin: PluginManifest; spec: NodeSpec }>();
  for (const m of manifests)
    for (const n of m.nodes) {
      if (nodeSpec(n.type)) throw new Error(`Plugin ${m.id}: ${n.type} is a built-in node type`);
      byType.set(n.type, { plugin: m, spec: toNodeSpec(n) });
    }
  const spec = (type: string) => nodeSpec(type) ?? byType.get(type)?.spec;
  return {
    spec,
    outputs: (type, config = {}) =>
      nodeSpec(type) ? nodeOutputs(type, config) : ((spec(type)?.outputs as string[]) ?? []),
    withDefaults: (type, config) => specDefaults(spec(type), config),
    validate: (type, config) => {
      const s = spec(type);
      return s ? validateFields(s, specDefaults(s, config)) : [missing(type)];
    },
    pluginNodes: () => [...byType.values()],
    installed: () => manifests.map((m) => m.id),
  };
}

/** The built-in catalog alone: what a deployment with no plugins runs. */
export const staticRegistry: NodeRegistry = withPlugins([]);

/** The message for a node whose plugin isn't installed (or doesn't offer that type). */
export function missing(type: string): string {
  const plugin = pluginOf(type);
  return plugin ? `Plugin “${plugin}” is not installed` : `Unknown node type “${type}”`;
}
