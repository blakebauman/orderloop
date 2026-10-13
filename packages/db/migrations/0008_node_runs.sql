-- One row per finished node run, written by the OrderAgent, for per-node timing on the dashboard.
CREATE TABLE node_runs (
  order_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  run INTEGER NOT NULL,
  node_type TEXT NOT NULL,
  order_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (order_id, generation, node_id, run)
);
CREATE INDEX node_runs_type ON node_runs(node_type, ended_at);
