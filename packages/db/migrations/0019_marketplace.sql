-- Marketplace: third-party sellers, the part of each order a seller fulfils, and their payouts.
CREATE TABLE sellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  commission_pct REAL NOT NULL DEFAULT 0.15,
  auto_accept INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- NULL means the marketplace operator sells it (first party).
ALTER TABLE products ADD COLUMN seller_id TEXT;

-- One row per order and seller. Status: pending | accepted | rejected | cancelled.
CREATE TABLE seller_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lines TEXT NOT NULL,
  subtotal REAL NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX seller_orders_order ON seller_orders(order_id);

-- Status: scheduled | reversed | paid. Amounts are in the order's currency.
CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  gross REAL NOT NULL,
  commission REAL NOT NULL,
  refunded REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX payouts_order ON payouts(order_id);
CREATE INDEX payouts_seller ON payouts(seller_id, created_at);

INSERT INTO sellers (id, name, email, commission_pct, auto_accept) VALUES
  ('sel_brightside', 'Brightside Audio', 'orders@brightside.example', 0.12, 1),
  ('sel_kettle', 'Kettle & Co', 'shop@kettleandco.example', 0.15, 0);

INSERT INTO products (sku, name, price, cost, stock, reserved, reorder_point, reorder_qty, supplier, seller_id) VALUES
  ('HP-200', 'Wireless headphones', 129.0, 0, 80, 0, 0, 0, 'Brightside Audio', 'sel_brightside'),
  ('KET-01', 'Gooseneck kettle', 79.0, 0, 45, 0, 0, 0, 'Kettle & Co', 'sel_kettle');
