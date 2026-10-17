-- One-time codes for MCP actions (apps/engine/src/confirmations.ts): a call previews the action
-- and returns a code; the action runs only when the same caller calls again with the same input
-- and the code, within five minutes. Expired rows are dropped by the retention sweep.
CREATE TABLE action_confirmations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX action_confirmations_expires ON action_confirmations(expires_at);
