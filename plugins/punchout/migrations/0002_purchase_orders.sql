-- Each version of a buyer's purchase order this plugin acted on, by the key it started (or
-- cancelled) it under (`cxml:<partner>:<payloadID>`), so a later `update` or `delete` of the same
-- orderID finds the order the version before started, and a resent document changes nothing.
--
-- A version is claimed (inserted with no order_id) before the plugin acts on it, and the unique
-- (partner_id, order_ref, version) lets only one of two changes sent at once claim the next
-- version. order_id is set once the version's order started (or, for a delete, was cancelled); a
-- claim whose action failed is deleted, so the PO keeps the version before it.
CREATE TABLE purchase_orders (
  key TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  order_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX purchase_orders_version ON purchase_orders(partner_id, order_ref, version);
