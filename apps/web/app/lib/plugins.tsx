/**
 * The installed plugins' manifests, loaded once by the shell. Kept apart from the node registry
 * (`~/lib/nodes`): building that needs the node catalog and its zod schemas, which only the pages
 * that draw nodes load, so the shell every page loads stays without them.
 */

import type { PluginManifest } from '@orderloop/core';
import { createContext, useContext } from 'react';

const PluginsContext = createContext<PluginManifest[]>([]);

export function PluginsProvider({
  plugins,
  children,
}: {
  plugins: PluginManifest[];
  children: React.ReactNode;
}) {
  return <PluginsContext.Provider value={plugins}>{children}</PluginsContext.Provider>;
}

export const usePlugins = () => useContext(PluginsContext);
