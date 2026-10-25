-- Who made each API token, by user id, so disabling or demoting that person revokes it. Until now
-- only `created_by` (their email, or name) said so, which changes when their email does. Filled in
-- for existing tokens from that email; null for tokens no current person's email matches, which
-- code still revokes by `created_by` as before.
ALTER TABLE api_tokens ADD COLUMN created_by_id TEXT;
UPDATE api_tokens SET created_by_id = (SELECT id FROM users WHERE users.email = api_tokens.created_by) WHERE created_by_id IS NULL;
CREATE INDEX IF NOT EXISTS api_tokens_created_by_id ON api_tokens (created_by_id);
