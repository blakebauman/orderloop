-- Fulfillment: stores that hold their own stock (pickup, ship-from-store, point of sale) and digital
-- goods. Central warehouse stock stays on products.
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'store',
  postal_code TEXT NOT NULL DEFAULT '',
  pickup INTEGER NOT NULL DEFAULT 1,
  ships INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE location_stock (
  location_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, sku)
);

-- physical | digital. Digital goods are delivered as entitlements and hold no stock.
ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'physical';
-- NULL is central stock (products); otherwise the store the stock is held at.
ALTER TABLE reservations ADD COLUMN location_id TEXT;
ALTER TABLE stock_movements ADD COLUMN location_id TEXT;

-- A licence key, download or gift card code. Status: issued | revoked.
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX entitlements_order ON entitlements(order_id);

INSERT INTO locations (id, name, kind, postal_code, pickup, ships) VALUES
  ('loc_soho', 'SoHo store', 'store', '10012', 1, 1),
  ('loc_mission', 'Mission store', 'store', '94110', 1, 0);

INSERT INTO products (sku, name, price, cost, stock, reserved, reorder_point, reorder_qty, supplier, kind) VALUES
  ('TEE-01', 'Organic cotton tee', 32.0, 9.0, 0, 0, 0, 0, 'Loom Works', 'physical'),
  ('EBK-101', 'Field guide (e-book)', 18.0, 0, 0, 0, 0, 0, 'OrderLoop Press', 'digital'),
  ('GFT-25', '$25 gift card', 25.0, 0, 0, 0, 0, 0, 'OrderLoop', 'digital');

INSERT INTO location_stock (location_id, sku, stock) VALUES
  ('loc_soho', 'TEE-01', 24),
  ('loc_soho', 'MON-27', 6),
  ('loc_mission', 'TEE-01', 12),
  ('loc_mission', 'MON-27', 3);
