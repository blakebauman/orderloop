-- The places a customer's orders ship to, for the customer page: one row per place (`key`, the
-- normalised address without the recipient's name, from `rememberedAddress` in core), written
-- when an order with a customer and a usable ship-to starts. `orders` counts the orders that used
-- it; `last_order_id` is the newest. Orders started before this table aren't counted: their
-- ship-to lives only in each order's agent state. Erasing the customer deletes the rows, and the
-- personal data retention sweep deletes rows last used before its cutoff. A new table: no
-- existing row or reader changes.
CREATE TABLE customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  region TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL,
  orders INTEGER NOT NULL DEFAULT 1,
  first_used_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  last_order_id TEXT NOT NULL
);

CREATE UNIQUE INDEX customer_addresses_key ON customer_addresses (customer_id, key);
CREATE INDEX customer_addresses_last_used ON customer_addresses (customer_id, last_used_at);
CREATE INDEX customer_addresses_used ON customer_addresses (last_used_at);
