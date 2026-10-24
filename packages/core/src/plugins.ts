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
import type { Order } from './types';
import { OUTBOUND_EVENTS, type OutboundPayload } from './webhooks';

/** Node type prefixes the built-in catalog uses; no plugin may take one as its id. */
const RESERVED_IDS = new Set(['trigger', 'commerce', 'control', 'ai', 'core', 'orderloop']);

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** The binding a plugin is reached by: "ledger" → "PLUGIN_LEDGER", "qbd-sync" → "PLUGIN_QBD_SYNC". */
export const pluginBinding = (id: string) => `PLUGIN_${id.toUpperCase().replace(/-/g, '_')}`;

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
  fields: z.array(fieldSchema),
  outputs: z.array(z.string().min(1)).min(1),
  /** The plugin's `compensate` runs for this node when the order fails after it. */
  rollback: z.boolean().optional(),
  retries: z.number().int().min(0).max(10).optional(),
});

export type PluginNodeSpec = z.infer<typeof nodeSchema>;

export const pluginManifestSchema = z
  .object({
    id: pluginId,
    name: z.string().min(1),
    /** Changes whenever the manifest does; the engine caches manifests by it. */
    version: z.string().min(1),
    nodes: z.array(nodeSchema).default([]),
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
    for (const [key, paths] of [
      ['nav', m.nav.map((n) => n.path)],
      ['publicPaths', m.publicPaths],
    ] as const)
      for (const [i, p] of paths.entries())
        if (!p.startsWith(prefix))
          ctx.addIssue({ code: 'custom', path: [key, i], message: `Must start with ${prefix}` });
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
  order: Order;
  vars: Record<string, unknown>;
  /** Earlier nodes' outputs, by node id. */
  nodes: Record<string, unknown>;
};

/** The same shape a built-in executor returns. */
export type PluginExecResult = {
  /** One of the node's `outputs`; defaults to the first. */
  branch?: string;
  output?: unknown;
  summary?: string;
  vars?: Record<string, unknown>;
};

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
