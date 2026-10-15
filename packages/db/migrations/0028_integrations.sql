-- External systems that sign webhooks, each with its own secret and scope. Replaces the single
-- WEBHOOK_SECRET: a key may deliver only its events, start orders only if allowed, name only its
-- flows, and reach only its channel. A rotated-out secret works until previous_expires_at.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_expires_at INTEGER,
  events TEXT NOT NULL DEFAULT '[]',
  start_orders INTEGER NOT NULL DEFAULT 0,
  flows TEXT NOT NULL DEFAULT '[]',
  channel TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_used_at INTEGER,
  revoked_at INTEGER
);
