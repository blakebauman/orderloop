-- Archiving a flow draft that was never published (no order can be on it): it leaves the flows
-- list until restored. Null for every flow in use.
ALTER TABLE flows ADD COLUMN archived_at INTEGER;
