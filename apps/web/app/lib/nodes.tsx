/**
 * The node types this deployment knows: the built-in catalog plus its installed plugins' nodes.
 * The shell provides the plugins' manifests (`~/lib/plugins`); the editor, inspector and run views
 * read node specs through `useNodes()` instead of the built-in `nodeSpec`, so a plugin's nodes
 * render like any other.
 */

import { type NodeRegistry, staticRegistry, withPlugins } from '@orderloop/core';
import { useMemo } from 'react';
import { usePlugins } from '~/lib/plugins';

// One registry per set of manifests, shared by every component that asks for it.
let cached: { key: string; registry: NodeRegistry } | null = null;

export function useNodes(): NodeRegistry {
  const plugins = usePlugins();
  const key = JSON.stringify(plugins);
  // Keyed by content (`key`), not by the array's identity.
  return useMemo(() => {
    if (!plugins.length) return staticRegistry;
    if (cached?.key !== key) cached = { key, registry: withPlugins(plugins) };
    return cached.registry;
  }, [key]);
}
