-- Carts (packages/core/src/cart.ts) and promotions (the commerce.discount node). New tables only;
-- nothing existing changes.
--
-- carts: the index the Carts page lists. Each cart's lines, quote and chat live in its CartAgent;
-- this row is written by the agent whenever the cart's title or status changes. plugin_id and
-- session_ref are set for an external cart a plugin opened (a punchout session), and are unique
-- together, so opening the same session twice finds the same cart.
CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT,
  flow_id TEXT NOT NULL,
  plugin_id TEXT,
  session_ref TEXT,
  order_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX carts_updated ON carts(updated_at);
CREATE INDEX carts_status ON carts(status, updated_at);
CREATE UNIQUE INDEX carts_session ON carts(plugin_id, session_ref) WHERE plugin_id IS NOT NULL;

-- promotions: codes a buyer or staff enter on a cart or order. kind is pct (value is a percentage),
-- amount (value off the subtotal, in currency) or free_shipping. skus is a JSON array the discount
-- is limited to, or null for every line; customer_id limits it to one customer.
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  currency TEXT,
  min_subtotal REAL,
  skus TEXT,
  customer_id TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  max_redemptions INTEGER,
  per_customer_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX promotions_code ON promotions(code);

-- promotion_redemptions: one row per promotion per order, written by the discount node's step, so
-- a retried step redeems once. Counted against max_redemptions and per_customer_limit.
CREATE TABLE promotion_redemptions (
  promotion_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT,
  amount REAL NOT NULL,
  step_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (promotion_id, order_id)
);
CREATE INDEX promotion_redemptions_customer ON promotion_redemptions(promotion_id, customer_id);
