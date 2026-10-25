-- When a temporary password (one an admin set: a new person's, or a reset) stops working, so a
-- password sent and never used doesn't stay a way in. Null for passwords people chose themselves,
-- and for temporary ones set before this, which keep working until changed.
ALTER TABLE users ADD COLUMN password_expires_at INTEGER;
