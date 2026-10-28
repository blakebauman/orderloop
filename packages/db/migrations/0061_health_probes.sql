-- The deploy smoke test's write check (POST /health/write): the web app and the engine each write
-- a row here, read it back and delete it, so a deploy whose D1 can't take writes fails and rolls
-- back. Nothing else reads it, and it's empty between checks. A new table: no existing row or
-- reader changes.
CREATE TABLE health_probes (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
