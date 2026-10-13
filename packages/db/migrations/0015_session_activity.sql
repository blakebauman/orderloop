-- Session activity, for the idle timeout and the Account page's session list. Existing sessions
-- count as last seen when they were created.
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
