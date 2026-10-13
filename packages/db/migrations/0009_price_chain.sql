-- The pricing chain for commerce.price: sources in priority order, and the price-book and volume
-- entries in them. Contract prices stay in contract_prices as the contract source's entries; list
-- price (products.price) is the fallback.
CREATE TABLE price_sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  priority INTEGER NOT NULL,
  stop_processing INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE price_rules (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES price_sources(id),
  name TEXT NOT NULL,
  sku TEXT,
  customer_id TEXT,
  customer_tier TEXT,
  min_qty REAL,
  price REAL,
  discount_pct REAL,
  starts_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX price_rules_source ON price_rules(source_id);

INSERT INTO price_sources (id, label, priority, stop_processing) VALUES
  ('price_book', 'Price books', 10, 1),
  ('contract', 'Contract prices', 20, 1),
  ('volume', 'Volume tiers', 30, 0);

INSERT INTO price_rules (id, source_id, name, sku, customer_tier, min_qty, price, discount_pct, created_at) VALUES
  ('pb_silver_wid200', 'price_book', 'Silver price book', 'WID-200', 'silver', NULL, 55.0, NULL, 0),
  ('vol_wid100_500', 'volume', 'Industrial widget, 500+', 'WID-100', NULL, 500, NULL, 8, 0),
  ('vol_gsk010_1000', 'volume', 'Gasket kit, 1,000+', 'GSK-010', NULL, 1000, 7.75, NULL, 0),
  ('vol_brg608_10000', 'volume', 'Bearing, 10,000+', 'BRG-608', NULL, 10000, 1.7, NULL, 0);
