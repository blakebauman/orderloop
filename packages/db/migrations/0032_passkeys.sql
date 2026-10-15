-- Passkeys (WebAuthn credentials) people sign in with instead of a password and code, and the
-- one-use challenges a registration or sign-in answers.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);
