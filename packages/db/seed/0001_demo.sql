-- Demo data for local development, tests and demos: customers, a catalog with marketplace
-- sellers and digital goods, two stores with stock, contract and volume prices, and EUR, GBP and
-- CAD at fixed rates. It is not a migration, so production never gets it (migration 0027 removed
-- the copy the early migrations had put there). `pnpm db:seed:local` loads it, and the engine
-- tests load it after the migrations. INSERT OR IGNORE, so loading it twice changes nothing.

INSERT OR IGNORE INTO customers (id, name, email, tier, credit_limit, balance, terms, kind) VALUES
  ('cus_ada', 'Ada Lovelace', 'ada@example.com', 'consumer', 0.0, 0.0, 'due_on_receipt', 'consumer'),
  ('cus_contoso', 'Contoso Ltd', 'ap@contoso.example', 'standard', 20000.0, 18500.0, 'net_30', 'business'),
  ('cus_fabrikam', 'Fabrikam Inc', 'orders@fabrikam.example', 'silver', 50000.0, 0.0, 'net_15', 'business'),
  ('cus_northwind', 'Northwind Traders', 'purchasing@northwind.example', 'gold', 100000.0, 12000.0, 'net_30', 'business');

INSERT OR IGNORE INTO sellers (id, name, email, commission_pct, auto_accept, active) VALUES
  ('sel_brightside', 'Brightside Audio', 'orders@brightside.example', 0.12, 1, 1),
  ('sel_kettle', 'Kettle & Co', 'shop@kettleandco.example', 0.15, 0, 1);

INSERT OR IGNORE INTO locations (id, name, kind, postal_code, pickup, ships, latitude, longitude) VALUES
  ('loc_mission', 'Mission store', 'store', '94110', 1, 1, 37.7599, -122.4148),
  ('loc_soho', 'SoHo store', 'store', '10012', 1, 1, 40.7233, -74.003);

INSERT OR IGNORE INTO products (sku, name, price, cost, stock, reserved, reorder_point, reorder_qty, supplier, seller_id, kind) VALUES
  ('BRG-608', 'Bearing 608-2RS', 1.9, 0.62, 25000, 0, 5000, 20000, 'Seal Partners', NULL, 'physical'),
  ('EBK-101', 'Field guide (e-book)', 18.0, 0.0, 0, 0, 0, 0, 'OrderLoop Press', NULL, 'digital'),
  ('GFT-25', '$25 gift card', 25.0, 0.0, 0, 0, 0, 0, 'OrderLoop', NULL, 'digital'),
  ('GSK-010', 'Gasket kit', 8.5, 3.1, 4000, 0, 800, 3000, 'Seal Partners', NULL, 'physical'),
  ('HP-200', 'Wireless headphones', 129.0, 0.0, 80, 0, 0, 0, 'Brightside Audio', 'sel_brightside', 'physical'),
  ('KET-01', 'Gooseneck kettle', 79.0, 0.0, 45, 0, 0, 0, 'Kettle & Co', 'sel_kettle', 'physical'),
  ('LAP-14', '14" laptop', 1299.0, 980.0, 35, 0, 10, 25, 'Tech Distribution', NULL, 'physical'),
  ('MON-27', '27" monitor', 349.0, 240.0, 60, 0, 15, 40, 'Tech Distribution', NULL, 'physical'),
  ('MTR-750', 'Servo motor 750W', 420.0, 260.0, 18, 0, 20, 40, 'Volt Motion', NULL, 'physical'),
  ('SUB-BOX', 'Monthly coffee box', 29.0, 12.0, 900, 0, 200, 600, 'Roastery Co.', NULL, 'physical'),
  ('TEE-01', 'Organic cotton tee', 32.0, 9.0, 0, 0, 0, 0, 'Loom Works', NULL, 'physical'),
  ('WID-100', 'Industrial widget', 24.0, 11.5, 1200, 0, 300, 1000, 'Acme Supply Co.', NULL, 'physical'),
  ('WID-200', 'Heavy-duty widget', 59.0, 27.0, 140, 0, 150, 400, 'Acme Supply Co.', NULL, 'physical');

INSERT OR IGNORE INTO location_stock (location_id, sku, stock, reserved) VALUES
  ('loc_mission', 'MON-27', 3, 0),
  ('loc_mission', 'TEE-01', 12, 0),
  ('loc_soho', 'MON-27', 6, 0),
  ('loc_soho', 'TEE-01', 24, 0);

INSERT OR IGNORE INTO contract_prices (customer_id, sku, price) VALUES
  ('cus_fabrikam', 'BRG-608', 1.55),
  ('cus_fabrikam', 'MTR-750', 389.0),
  ('cus_northwind', 'GSK-010', 7.25),
  ('cus_northwind', 'WID-100', 21.5),
  ('cus_northwind', 'WID-200', 52.0);

INSERT OR IGNORE INTO price_rules (id, source_id, name, sku, customer_id, customer_tier, min_qty, price, discount_pct, starts_at, ends_at, created_at) VALUES
  ('pb_silver_wid200', 'price_book', 'Silver price book', 'WID-200', NULL, 'silver', NULL, 55.0, NULL, NULL, NULL, 0),
  ('vol_brg608_10000', 'volume', 'Bearing, 10,000+', 'BRG-608', NULL, NULL, 10000.0, 1.7, NULL, NULL, NULL, 0),
  ('vol_gsk010_1000', 'volume', 'Gasket kit, 1,000+', 'GSK-010', NULL, NULL, 1000.0, 7.75, NULL, NULL, NULL, 0),
  ('vol_wid100_500', 'volume', 'Industrial widget, 500+', 'WID-100', NULL, NULL, 500.0, NULL, 8.0, NULL, NULL, 0);

INSERT OR IGNORE INTO fx_rates (currency, rate, updated_at) VALUES
  ('CAD', 1.37, 0),
  ('EUR', 0.92, 0),
  ('GBP', 0.79, 0);
