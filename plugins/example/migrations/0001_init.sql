-- Stamps written by the example.stamp node, one per order and step key; compensation deletes them.
CREATE TABLE stamps (
  order_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (order_id, step_key)
);

-- Outbound events delivered to the plugin, one per delivery id.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  order_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
