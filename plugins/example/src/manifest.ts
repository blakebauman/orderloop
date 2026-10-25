/**
 * The example plugin's manifest, in its own module with no Worker imports, so CI can read it
 * (scripts/plugin-bundle.ts) without running the plugin. See docs/plugins.md.
 */

import type { ManifestInput } from '@orderloop/plugin-sdk';

export default {
  apiVersion: 1,
  id: 'example',
  name: 'Example',
  version: '4',
  nodes: [
    {
      type: 'example.stamp',
      category: 'commerce',
      label: 'Stamp',
      description: 'Records a stamp for the order in the example plugin.',
      icon: 'Stamp',
      fields: [
        { key: 'note', label: 'Note', kind: 'text', default: 'stamped' },
        {
          key: 'skip',
          label: 'Skip',
          kind: 'boolean',
          default: false,
          hint: 'Take the “skipped” branch without stamping.',
        },
      ],
      outputs: ['ok', 'skipped'],
      rollback: true,
    },
    {
      type: 'example.probe',
      category: 'control',
      label: 'Probe',
      description: 'Test-only: behaves as told, to check what the engine accepts from a plugin.',
      icon: 'FlaskConical',
      fields: [
        {
          key: 'behave',
          label: 'Behave',
          kind: 'select',
          options: [
            'echo',
            'fail',
            'fail_retry',
            'big',
            'bad_branch',
            'vars',
            'leak',
            'fetch',
            'env',
            'throw',
            'post_big',
          ],
          default: 'echo',
        },
      ],
      outputs: ['out'],
    },
  ],
  events: ['order.completed'],
  nav: [{ label: 'Example', path: '/plugins/example/', icon: 'Puzzle' }],
  publicPaths: ['/plugins/example/public/ping'],
  // Opens external carts, and starts and cancels orders, through ORDERLOOP (granted in the engine's
  // tests).
  capabilities: ['carts:external', 'orders:start', 'orders:cancel'],
  secrets: [
    {
      name: 'PING_TOKEN',
      description: 'When set, the public ping answers only a bearer of this token',
      optional: true,
      expose: true,
    },
  ],
  // Sandboxed, it may reach these hosts only (the probe's "fetch" behaviour, in tests).
  egress: ['api.carrier.test', '*.allowed.test'],
} satisfies ManifestInput;
