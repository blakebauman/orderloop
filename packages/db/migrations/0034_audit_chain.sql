-- The audit log becomes append-only and tamper-evident. Each new event is sealed into a hash
-- chain (seq, prev_hash, hash); events written before this have none. Pruning moves from every
-- write to the engine's daily sweep, which archives events to R2 before deleting them.
ALTER TABLE audit_events ADD COLUMN seq INTEGER;
ALTER TABLE audit_events ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_events ADD COLUMN hash TEXT;
CREATE UNIQUE INDEX audit_events_seq ON audit_events(seq);

-- No event is ever changed.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be changed');
END;

-- None younger than 90 days is deleted (AUDIT_MIN_RETENTION_DAYS in core). The web app's
-- 180-day prune on write, still deployed while this applies, deletes only older ones.
CREATE TRIGGER audit_events_keep_90_days BEFORE DELETE ON audit_events
WHEN old.at > (CAST(strftime('%s', 'now') AS INTEGER) - 90 * 86400) * 1000
BEGIN
  SELECT RAISE(ABORT, 'audit events are kept at least 90 days');
END;
