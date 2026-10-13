-- People and API tokens with roles (viewer < approver < operator), replacing the single shared
-- password. Secrets are stored only as hashes. external_sub links a user to an outside identity
-- provider's subject once sign-in through one exists.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT,
  external_sub TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER
);
CREATE UNIQUE INDEX users_email ON users(email);
CREATE UNIQUE INDEX users_external_sub ON users(external_sub) WHERE external_sub IS NOT NULL;

-- A session cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Bearer tokens for the REST API (ol_live_…), each with a role.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX api_tokens_hash ON api_tokens(token_hash);
