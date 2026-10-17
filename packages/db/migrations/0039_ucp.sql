-- Agentic checkout over the Universal Commerce Protocol (apps/engine/src/ucp/).
--
-- ucp_platforms: the AI shopping platforms an admin has let in. Each calls with its own API key
-- (only the SHA-256 is kept) and names its UCP profile in UCP-Agent, which must be the one
-- registered. The profile is fetched and kept here for an hour, for its capabilities and the
-- order webhook URL.
CREATE TABLE ucp_platforms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  profile TEXT,
  profile_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX ucp_platforms_key ON ucp_platforms(key_hash);

-- Checkout sessions: the session as JSON in data, with the fields queries need beside it.
-- version is compared on every write, so an update can't interleave with a completion.
CREATE TABLE checkout_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  order_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX checkout_sessions_owner ON checkout_sessions(owner_id, created_at);
CREATE INDEX checkout_sessions_expires ON checkout_sessions(expires_at);
CREATE UNIQUE INDEX checkout_sessions_order ON checkout_sessions(order_id) WHERE order_id IS NOT NULL;

-- Idempotency-Key replays for the UCP endpoints, per platform: the request's digest and the
-- response it got. status is null while the first request is still running. Kept 24 hours.
CREATE TABLE ucp_idempotency (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key)
);
CREATE INDEX ucp_idempotency_created ON ucp_idempotency(created_at);
