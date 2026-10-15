-- Invoices issued through Stripe by commerce.invoice (provider "stripe"). The row is written before
-- Stripe is called and records the due date it asks for, so a retried step sends the same request
-- under the same idempotency key. status: pending (nothing in Stripe yet) → draft → open → paid |
-- void. `balance_entry_id` is the account charge the invoice made, settled when it is paid.
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  number TEXT,
  hosted_url TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  terms TEXT NOT NULL,
  due_at INTEGER,
  balance_entry_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX invoices_order ON invoices(order_id);
CREATE UNIQUE INDEX invoices_external ON invoices(external_id) WHERE external_id IS NOT NULL;

-- Stripe events already handled, by event id. Stripe retries a delivery for up to three days, far
-- longer than webhook_receipts keeps a signature, so these are kept 30 days (retention.ts).
CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  order_id TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX payment_events_received ON payment_events(received_at);
