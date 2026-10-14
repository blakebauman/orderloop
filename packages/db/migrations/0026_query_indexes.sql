-- Indexes for queries that ran as full scans: the order list's default sorts, metrics over a
-- time range (orders, node runs, payments), email intake's sender lookup, and the daily
-- retention sweep (sessions, webhook deliveries).
CREATE INDEX orders_created ON orders(created_at);
CREATE INDEX orders_updated ON orders(updated_at);
CREATE INDEX node_runs_ended ON node_runs(ended_at);
CREATE INDEX payments_status_created ON payments(status, created_at);
CREATE INDEX customers_email ON customers(lower(email));
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX webhook_deliveries_created ON webhook_deliveries(created_at);
