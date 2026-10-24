/**
 * The punchout plugin's manifest, in its own module with no Worker imports, so CI can read it
 * (scripts/plugin-bundle.ts) without running the plugin. See docs/plugins.md.
 */

import type { ManifestInput } from '@orderloop/plugin-sdk';

export default {
  apiVersion: 1,
  id: 'punchout',
  name: 'Punchout',
  version: '1',
  // Opens a cart for a procurement system's buyer, and starts the order its PO sends.
  capabilities: ['carts:external', 'orders:start'],
  nav: [{ label: 'Punchout', path: '/plugins/punchout/', icon: 'ShoppingCart' }],
  pageRole: 'admin',
  // The procurement systems call these themselves; each checks the partner's secret.
  publicPaths: [
    '/plugins/punchout/cxml/setup',
    '/plugins/punchout/cxml/order',
    '/plugins/punchout/oci/setup',
  ],
} satisfies ManifestInput;
