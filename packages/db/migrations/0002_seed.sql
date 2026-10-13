-- Demo back office. Flows are seeded by the engine from @orderloop/core templates.
INSERT INTO customers (id, name, email, tier, credit_limit, balance, terms) VALUES
  ('cus_northwind', 'Northwind Traders', 'purchasing@northwind.example', 'gold', 100000, 12000, 'net_30'),
  ('cus_contoso', 'Contoso Ltd', 'ap@contoso.example', 'standard', 20000, 18500, 'net_30'),
  ('cus_fabrikam', 'Fabrikam Inc', 'orders@fabrikam.example', 'silver', 50000, 0, 'net_15'),
  ('cus_ada', 'Ada Lovelace', 'ada@example.com', 'consumer', 0, 0, 'due_on_receipt'),
  ('cus_internal', 'Internal — Operations', 'ops@orderloop.example', 'internal', 0, 0, 'due_on_receipt');

INSERT INTO products (sku, name, price, cost, stock, reserved, reorder_point, reorder_qty, supplier) VALUES
  ('WID-100', 'Industrial widget', 24.0, 11.5, 1200, 0, 300, 1000, 'Acme Supply Co.'),
  ('WID-200', 'Heavy-duty widget', 59.0, 27.0, 140, 0, 150, 400, 'Acme Supply Co.'),
  ('GSK-010', 'Gasket kit', 8.5, 3.1, 4000, 0, 800, 3000, 'Seal Partners'),
  ('BRG-608', 'Bearing 608-2RS', 1.9, 0.62, 25000, 0, 5000, 20000, 'Seal Partners'),
  ('MTR-750', 'Servo motor 750W', 420.0, 260.0, 18, 0, 20, 40, 'Volt Motion'),
  ('LAP-14', '14" laptop', 1299.0, 980.0, 35, 0, 10, 25, 'Tech Distribution'),
  ('MON-27', '27" monitor', 349.0, 240.0, 60, 0, 15, 40, 'Tech Distribution'),
  ('SUB-BOX', 'Monthly coffee box', 29.0, 12.0, 900, 0, 200, 600, 'Roastery Co.');

INSERT INTO contract_prices (customer_id, sku, price) VALUES
  ('cus_northwind', 'WID-100', 21.5),
  ('cus_northwind', 'WID-200', 52.0),
  ('cus_northwind', 'GSK-010', 7.25),
  ('cus_fabrikam', 'MTR-750', 389.0),
  ('cus_fabrikam', 'BRG-608', 1.55);
