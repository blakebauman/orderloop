-- Two-factor sign-in: an authenticator-app secret per person, one-use recovery codes, and the
-- short-lived step between a correct password and a correct code.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX recovery_codes_user ON recovery_codes (user_id);

CREATE TABLE sign_in_challenges (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
