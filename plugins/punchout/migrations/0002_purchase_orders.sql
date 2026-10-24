-- Each version of a buyer's purchase order this plugin acted on, by the key it started (or
-- cancelled) it under (`cxml:<partner>:<payloadID>`), so a later `update` or `delete` of the same
-- orderID finds the order the version before started, and a resent document changes nothing.
CREATE TABLE purchase_orders (
  key TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  order_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX purchase_orders_ref ON purchase_orders(partner_id, order_ref, created_at);
