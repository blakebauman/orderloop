-- Security audit log: sign-ins, team and token changes, failed shared-password API attempts.
-- Written by the web app; kept 180 days.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  actor_id TEXT,
  actor_kind TEXT,
  target TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX audit_events_at ON audit_events(at);
CREATE INDEX audit_events_action ON audit_events(action, at);
