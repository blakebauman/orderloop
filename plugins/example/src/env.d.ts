// Secrets set with `wrangler secret put` (scripts/fleet.ts secrets plugin); `wrangler types` can't see them.
interface Env {
  /** Shared with the web Worker: verifies the principal it signs onto forwarded page requests. */
  PRINCIPAL_KEY?: string;
  /** The key before a rotation, still accepted until the web Worker signs with the new one. */
  PRINCIPAL_KEY_PREVIOUS?: string;
}
