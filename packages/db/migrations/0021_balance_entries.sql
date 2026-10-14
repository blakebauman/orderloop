-- Each change to a customer's balance, keyed by the step that made it, so a retried invoice step
-- bills the account once. Applied in the same batch as the balance update, like stock_movements.
CREATE TABLE balance_entries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount REAL NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX balance_entries_customer ON balance_entries(customer_id, created_at);
