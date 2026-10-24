// Secrets set with `wrangler secret put` (scripts/fleet.ts secrets plugin); `wrangler types` can't see them.
interface Env {
  /** This plugin's own page-signing key (`pluginKey` in @orderloop/core); never the principal key. */
  PLUGIN_KEY?: string;
  /** The key before a rotation, still accepted until the web Worker signs with the new one. */
  PLUGIN_KEY_PREVIOUS?: string;
  /** Optional: the deployment's PLUGIN_EXAMPLE_PING_TOKEN, under its own name. */
  PING_TOKEN?: string;
}
