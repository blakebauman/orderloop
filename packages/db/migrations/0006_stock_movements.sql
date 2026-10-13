-- A ledger of inventory changes, one row per step, line and kind. A connector records the row and
-- applies it in one batch, and only a row not yet applied changes stock, so a retried step can't
-- hold or restock twice.
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  kind TEXT NOT NULL,
  qty REAL NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX stock_movements_order ON stock_movements(order_id);
