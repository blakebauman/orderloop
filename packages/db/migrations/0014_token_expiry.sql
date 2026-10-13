-- API tokens can expire. NULL means the token never expires (every token made before this did).
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
