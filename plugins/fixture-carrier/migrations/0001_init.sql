-- Labels the fixture carrier created, one per order, step key and package; void marks them.
CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  tracking TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  -- Set for an order whose meta.simulate is "void_fails": voiding it fails until a test clears it.
  fail_void INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX labels_order ON labels(order_id);
