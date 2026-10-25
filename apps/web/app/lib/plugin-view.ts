/**
 * How the web Worker hands a plugin's view (`PluginView`, packages/core/src/plugin-ui.ts) to the
 * page that renders it in the app shell (routes/plugin-page.tsx): the Worker fetches the plugin page
 * as it always has and, when the answer is a view, renders it through React Router with the view in
 * the load context. The route never fetches the plugin itself.
 */

import type { CheckedPluginView } from '@orderloop/core';
import { createContext } from 'react-router';

export type PluginPageContext = {
  pluginId: string;
  /** The plugin's own pages, `/plugins/<id>/`, which a view's links and forms are relative to. */
  base: string;
  view: CheckedPluginView | null;
  /** Why the view couldn't be shown (it didn't parse, or broke a rule). */
  error: string | null;
  status: number;
};

export const pluginPageContext = createContext<PluginPageContext | null>(null);
