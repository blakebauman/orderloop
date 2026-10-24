import { describe, expect, it } from 'vitest';
import {
  checkExecResult,
  type FlowGraph,
  type Order,
  PLUGIN_RESULT_MAX_BYTES,
  parseManifest,
  pluginBinding,
  pluginOf,
  pluginOrder,
  pluginView,
  staticRegistry,
  TEMPLATES,
  validateGraph,
  withPlugins,
} from '../src';

const manifest = (over: Record<string, unknown> = {}) => ({
  apiVersion: 1,
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
    const m = parseManifest({ apiVersion: 1, id: 'example', name: 'Example', version: '1' });
    expect(m).toMatchObject({
      nodes: [],
      events: [],
      nav: [],
      publicPaths: [],
      requires: [],
      pageRole: 'operator',
      personalData: 'redact',
    });
    expect(parseManifest(manifest()).nodes[0]!.type).toBe('example.stamp');
  });

  it('refuses a manifest written for another contract version', () => {
    expect(() => parseManifest(manifest({ apiVersion: 2 }))).toThrow(/apiVersion must be 1/);
    expect(() => parseManifest({ ...manifest(), apiVersion: undefined })).toThrow(/apiVersion/);
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

describe('plugin results', () => {
  const outs = ['ok', 'skipped'];

  it('takes the first output by default and keeps what the node returned', () => {
    expect(checkExecResult('example.stamp', { output: { a: 1 }, summary: 'Done' }, outs)).toEqual({
      kind: 'done',
      branch: 'ok',
      output: { a: 1 },
      summary: 'Done',
      vars: undefined,
    });
    expect(checkExecResult('example.stamp', undefined, outs)).toMatchObject({ branch: 'ok' });
  });

  it('turns fail into a failure, retried only when the plugin says so', () => {
    expect(checkExecResult('x.y', { fail: { message: 'Declined' } }, outs)).toEqual({
      kind: 'fail',
      message: 'Declined',
      retry: false,
    });
    expect(checkExecResult('x.y', { fail: { message: 'Busy', retry: true } }, outs)).toMatchObject({
      retry: true,
    });
  });

  it('refuses a branch the node lacks, a long summary and an oversized output', () => {
    expect(() => checkExecResult('x.y', { branch: 'nope' }, outs)).toThrow(
      /isn't one of its outputs/,
    );
    expect(() => checkExecResult('x.y', { summary: 's'.repeat(301) }, outs)).toThrow(/summary/);
    const big = 'x'.repeat(PLUGIN_RESULT_MAX_BYTES);
    expect(() => checkExecResult('x.y', { output: big }, outs)).toThrow(/output is \d+ bytes/);
    expect(() => checkExecResult('x.y', { vars: { big } }, outs)).toThrow(/vars is \d+ bytes/);
    expect(() => checkExecResult('x.y', { vars: 'not an object' }, outs)).toThrow(/vars/);
  });
});

describe('what a plugin sees', () => {
  const order = {
    id: 'ord_1',
    model: 'b2c',
    channel: 'web',
    currency: 'USD',
    lines: [{ sku: 'WID-100', name: 'Widget', qty: 1, unitPrice: 5 }],
    contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
    meta: { shipTo: { line1: '1 Main St', city: 'Springfield' }, note: 'call 555 123 4567' },
    createdAt: 0,
    subtotal: 5,
    shipping: 0,
    tax: 0,
    total: 5,
  } as unknown as Order;

  it('gets no buyer details unless its manifest asks for them', () => {
    const seen = pluginOrder({ personalData: 'redact' }, order);
    expect(seen).not.toHaveProperty('contact');
    expect(seen.meta).not.toHaveProperty('shipTo');
    expect(JSON.stringify(seen)).not.toMatch(/ada|555 123/i);
    expect(seen.lines[0]).toMatchObject({ sku: 'WID-100', name: 'Widget' });
    expect(pluginOrder({ personalData: 'send' }, order)).toBe(order);
    expect(pluginView({ personalData: 'redact' }, { buyer: { email: 'a@b.co' }, n: 1 })).toEqual({
      n: 1,
    });
  });
});
