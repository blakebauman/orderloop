// Secrets set with `wrangler secret put` (scripts/fleet.ts secrets plugin); `wrangler types` can't see them.
interface Env {
  /** This plugin's own page-signing key (`pluginKey` in @orderloop/core); never the principal key. */
  PLUGIN_KEY?: string;
  PLUGIN_KEY_PREVIOUS?: string;
}
