/**
 * The node types this deployment knows: the built-in catalog plus its installed plugins' nodes.
 * The shell loads the plugins' manifests once; the editor, inspector and run views read node specs
 * through `useNodes()` instead of the built-in `nodeSpec`, so a plugin's nodes render like any other.
 */

import {
  type NodeRegistry,
  type PluginManifest,
  staticRegistry,
  withPlugins,
} from '@orderloop/core';
import { createContext, useContext, useMemo } from 'react';

const NodesContext = createContext<NodeRegistry>(staticRegistry);

export function NodesProvider({
  plugins,
  children,
}: {
  plugins: PluginManifest[];
  children: React.ReactNode;
}) {
  const key = JSON.stringify(plugins);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content, not identity.
  const registry = useMemo(() => (plugins.length ? withPlugins(plugins) : staticRegistry), [key]);
  return <NodesContext.Provider value={registry}>{children}</NodesContext.Provider>;
}

export const useNodes = () => useContext(NodesContext);
