// Secrets set with `wrangler secret put`; `wrangler types` can't see them.
interface Env {
  /** Extra senders allowed to start orders by email: addresses or @domains, comma-separated. */
  INTAKE_ALLOWLIST?: string;
}
