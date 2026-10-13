-- Per-order currency. Prices, credit limits and reports are in the base currency (USD); an order in
-- another currency is priced at the rate in fx_rates (units per 1 USD) and keeps that rate.
CREATE TABLE fx_rates (
  currency TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Demo rates; a real deployment refreshes these from a rates provider.
INSERT INTO fx_rates (currency, rate, updated_at) VALUES
  ('USD', 1, 0),
  ('EUR', 0.92, 0),
  ('GBP', 0.79, 0),
  ('CAD', 1.37, 0);

ALTER TABLE orders ADD COLUMN fx_rate REAL NOT NULL DEFAULT 1;
