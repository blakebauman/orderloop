// Bindings `wrangler types` can't see: the page-signing key (scripts/fleet.ts secrets plugin) and
// the core's host API (bound by fleet rendering when the registry grants a capability).
interface Env {
  /** This plugin's own page-signing key (`pluginKey` in @orderloop/core); never the principal key. */
  PLUGIN_KEY?: string;
  /** The key before a rotation, still accepted until the web Worker signs with the new one. */
  PLUGIN_KEY_PREVIOUS?: string;
  /** The core's host API, as this plugin (`PluginHostRpc`). */
  ORDERLOOP?: import('@orderloop/core').PluginHostRpc;
}
