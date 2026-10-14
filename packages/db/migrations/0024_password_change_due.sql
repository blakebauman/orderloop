-- A password an operator set (a new person's first, or a reset) is temporary: the person chooses
-- their own before they can do anything else.
ALTER TABLE users ADD COLUMN password_change_due INTEGER NOT NULL DEFAULT 0;
