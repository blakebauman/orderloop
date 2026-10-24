import { describe, expect, it } from 'vitest';
import {
  type FlowGraph,
  parseManifest,
  pluginBinding,
  pluginOf,
  staticRegistry,
  TEMPLATES,
  validateGraph,
  withPlugins,
} from '../src';

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'example',
  name: 'Example',
  version: '1',
  nodes: [
    {
      type: 'example.stamp',
      category: 'commerce',
      label: 'Stamp',
      description: 'Writes a stamp.',
      icon: 'Stamp',
      fields: [
        { key: 'note', label: 'Note', kind: 'text', default: 'hi' },
        { key: 'count', label: 'Count', kind: 'number' },
        {
          key: 'shape',
          label: 'Shape',
          kind: 'json',
          jsonSchema: { type: 'object', required: ['a'] },
        },
      ],
      outputs: ['ok', 'skipped'],
      rollback: true,
    },
  ],
  events: ['order.completed'],
  nav: [{ label: 'Example', path: '/plugins/example/', icon: 'Puzzle' }],
  ...over,
});

const flow = (type: string, handle = 'ok'): FlowGraph => ({
  nodes: [
    { id: 't', type: 'trigger.manual', label: 'Start', config: {}, position: { x: 0, y: 0 } },
    { id: 'p', type, label: 'Stamp', config: {}, position: { x: 0, y: 0 } },
    { id: 'e', type: 'control.end', label: 'End', config: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: 'a', source: 't', target: 'p' },
    { id: 'b', source: 'p', target: 'e', sourceHandle: handle },
  ],
});

describe('plugin manifests', () => {
  it('parses a valid manifest and fills defaults', () => {
    const m = parseManifest({ id: 'example', name: 'Example', version: '1' });
    expect(m).toMatchObject({ nodes: [], events: [], nav: [], publicPaths: [], requires: [] });
    expect(parseManifest(manifest()).nodes[0]!.type).toBe('example.stamp');
  });

  it('rejects bad and reserved ids', () => {
    expect(() => parseManifest(manifest({ id: 'Bad_ID' }))).toThrow(/id/);
    expect(() => parseManifest(manifest({ id: 'commerce' }))).toThrow(/reserved/);
  });

  it('requires node types in the plugin namespace', () => {
    const nodes = [{ ...manifest().nodes[0]!, type: 'other.stamp' }];
    expect(() => parseManifest(manifest({ nodes }))).toThrow(/example\.<name>/);
  });

  it('keeps nav and public paths under the plugin prefix', () => {
    expect(() => parseManifest(manifest({ publicPaths: ['/api/v1/x'] }))).toThrow(
      /\/plugins\/example\//,
    );
  });

  it('refuses a node type the built-in catalog has', () => {
    // A plugin can't be named after a built-in category, so a collision needs a forged manifest.
    const forged = { ...parseManifest(manifest()), id: 'commerce' };
    forged.nodes = [{ ...forged.nodes[0]!, type: 'commerce.ship' }];
    expect(() => withPlugins([forged])).toThrow(/built-in/);
  });

  it('names bindings and namespaces', () => {
    expect(pluginBinding('qbd-sync')).toBe('PLUGIN_QBD_SYNC');
    expect(pluginOf('example.stamp')).toBe('example');
    expect(pluginOf('commerce.ship')).toBeNull();
    expect(pluginOf('nodot')).toBeNull();
  });
});

describe('node registry', () => {
  const registry = withPlugins([parseManifest(manifest())]);

  it('knows built-in and plugin nodes', () => {
    expect(registry.spec('commerce.ship')?.label).toBeTruthy();
    expect(registry.spec('example.stamp')?.rollback).toBe(true);
    expect(registry.outputs('example.stamp')).toEqual(['ok', 'skipped']);
    expect(registry.withDefaults('example.stamp', { count: 2 })).toEqual({ note: 'hi', count: 2 });
    expect(registry.installed()).toEqual(['example']);
    expect(registry.pluginNodes().map((n) => n.spec.type)).toEqual(['example.stamp']);
  });

  it("validates a plugin node's fields", () => {
    expect(registry.validate('example.stamp', {})).toEqual([]);
    expect(registry.validate('example.stamp', { count: 'two' })[0]).toMatch(/Count/);
    expect(registry.validate('example.stamp', { shape: { b: 1 } })[0]).toMatch(/Shape/);
    expect(registry.validate('example.stamp', { shape: { a: 1 } })).toEqual([]);
  });

  it('accepts a flow with a plugin node only when the plugin is installed', () => {
    expect(validateGraph(flow('example.stamp'), registry).errors).toEqual([]);
    expect(validateGraph(flow('example.stamp')).errors[0]!.message).toBe(
      'Plugin “example” is not installed',
    );
    expect(validateGraph(flow('example.stamp', 'nope'), registry).errors[0]!.message).toContain(
      'no “nope” output',
    );
  });

  it('leaves built-in flows as they were', () => {
    for (const make of Object.values(TEMPLATES)) {
      const t = make();
      expect(validateGraph(t, registry)).toEqual(validateGraph(t, staticRegistry));
    }
  });
});
