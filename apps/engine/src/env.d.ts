// Secrets set with `wrangler secret put`; `wrangler types` can't see them.
interface Env {
  /** Extra senders allowed to start orders by email: addresses or @domains, comma-separated. */
  INTAKE_ALLOWLIST?: string;
  /** Live shipping carriers' credentials: JSON of carrier id → Authorization header value. */
  SHIPPING_CARRIER_AUTH?: string;
  /** Stripe secret or restricted key (sk_… / rk_…); required when PAYMENTS_MODE is "stripe". */
  STRIPE_SECRET_KEY?: string;
}
