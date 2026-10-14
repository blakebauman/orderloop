-- Signed webhook events already delivered, by signature, so a captured request replayed inside
-- the signature's five-minute window delivers nothing. Rows older than the window are pruned
-- when new ones arrive.
CREATE TABLE webhook_receipts (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX webhook_receipts_received ON webhook_receipts(received_at);
