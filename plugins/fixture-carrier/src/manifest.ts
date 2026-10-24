/**
 * The fixture-carrier plugin's manifest, in its own module with no Worker imports, so CI can read it
 * (scripts/plugin-bundle.ts) without running the plugin. See docs/plugins.md.
 */

import type { ManifestInput } from '@orderloop/plugin-sdk';

export default {
  apiVersion: 1,
  id: 'fixture-carrier',
  name: 'Fixture carrier',
  version: '1',
  personalData: 'send',
  provides: ['shipping.rates', 'shipping.labels', 'tax', 'address'],
  // Its "live" rates, sandboxed: the gateway adds API_KEY for this host, which the plugin never sees.
  egress: ['api.carrier.test'],
  secrets: [
    {
      name: 'API_KEY',
      description: 'The carrier API key (test only)',
      optional: true,
      inject: { host: 'api.carrier.test', header: 'Authorization', format: 'Bearer {}' },
    },
  ],
} satisfies ManifestInput;
