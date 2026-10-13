-- Flows: the editable draft lives in graph_json; publishing snapshots it into flow_versions.
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  order_type TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  published_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE flow_versions (
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  flow_json TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (flow_id, version)
);

-- The orders index. Live run state lives in each order's OrderAgent Durable Object.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  flow_id TEXT NOT NULL,
  flow_version INTEGER NOT NULL,
  instance_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  customer_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  total REAL NOT NULL DEFAULT 0,
  waiting_on TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX orders_status ON orders(status, updated_at);
CREATE INDEX orders_type ON orders(type, updated_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '',
  amount REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX approvals_status ON approvals(status, requested_at);
CREATE UNIQUE INDEX approvals_wait ON approvals(order_id, event_type);

-- Mock back office the commerce connectors read and write.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard',
  credit_limit REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  terms TEXT NOT NULL DEFAULT 'net_30'
);

CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 0,
  reorder_qty INTEGER NOT NULL DEFAULT 0,
  supplier TEXT NOT NULL DEFAULT ''
);

CREATE TABLE contract_prices (
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (customer_id, sku)
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reservations_order ON reservations(order_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_order ON payments(order_id);

CREATE TABLE shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX shipments_order ON shipments(order_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX documents_order ON documents(order_id);

-- Outbox for the notify node. Sent through Email Service when EMAIL_FROM is set.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_order ON messages(order_id);
