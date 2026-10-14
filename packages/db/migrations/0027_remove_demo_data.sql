-- The early migrations seeded demo data (0002, 0009, 0010, 0019, 0020, 0022), which put it in
-- production. This removes it, with the test orders placed against it. Demo data now lives in
-- packages/db/seed, loaded only for local development and tests.
--
-- Kept: cus_internal (the customer replenishment orders are placed for), the price sources (the
-- pricing chain's configuration) and USD, the base currency. With no other rate, an order in any
-- other currency is refused until its rate is added.

-- Orders placed against demo customers or demo SKUs, everything recorded for them, then the order.
CREATE TABLE _demo_orders AS
  SELECT id FROM orders
  WHERE customer_id IN ('cus_ada', 'cus_contoso', 'cus_fabrikam', 'cus_northwind', 'cus_internal')
     OR id IN (
       SELECT order_id FROM reservations
       WHERE sku IN ('BRG-608', 'EBK-101', 'GFT-25', 'GSK-010', 'HP-200', 'KET-01', 'LAP-14',
                     'MON-27', 'MTR-750', 'SUB-BOX', 'TEE-01', 'WID-100', 'WID-200')
     );

DELETE FROM approvals WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM balance_entries WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM documents WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM entitlements WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM inbound_emails WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM messages WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM node_runs WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM payments WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM payouts WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM reservations WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM seller_orders WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM shipments WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM stock_movements WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM webhook_deliveries WHERE order_id IN (SELECT id FROM _demo_orders);
DELETE FROM orders WHERE id IN (SELECT id FROM _demo_orders);
DROP TABLE _demo_orders;

-- The demo catalog, its prices and stock.
DELETE FROM contract_prices WHERE customer_id IN ('cus_ada', 'cus_contoso', 'cus_fabrikam', 'cus_northwind');
DELETE FROM price_rules WHERE id IN ('pb_silver_wid200', 'vol_wid100_500', 'vol_gsk010_1000', 'vol_brg608_10000');
DELETE FROM location_stock WHERE location_id IN ('loc_soho', 'loc_mission');
DELETE FROM products
  WHERE sku IN ('BRG-608', 'EBK-101', 'GFT-25', 'GSK-010', 'HP-200', 'KET-01', 'LAP-14', 'MON-27',
                'MTR-750', 'SUB-BOX', 'TEE-01', 'WID-100', 'WID-200');
DELETE FROM sellers WHERE id IN ('sel_brightside', 'sel_kettle');
DELETE FROM locations WHERE id IN ('loc_soho', 'loc_mission');
DELETE FROM balance_entries WHERE customer_id IN ('cus_ada', 'cus_contoso', 'cus_fabrikam', 'cus_northwind');
DELETE FROM customers WHERE id IN ('cus_ada', 'cus_contoso', 'cus_fabrikam', 'cus_northwind');
UPDATE customers SET balance = 0 WHERE id = 'cus_internal';

-- Demo exchange rates (fixed, never updated); USD stays as the base.
DELETE FROM fx_rates WHERE currency IN ('EUR', 'GBP', 'CAD');
