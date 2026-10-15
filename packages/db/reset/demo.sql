-- Puts a demo deployment (demo.orderloop.app) back to its starting point: removes everything
-- visitors made, then 0001_demo.sql loads the demo data again. Run by
-- .github/workflows/demo-reset.yml, never on any other deployment.
--
-- Kept: the people, their tokens and sessions (except the demo visitor's), settings,
-- integrations, webhook subscriptions, the price sources, cus_internal and USD. Flow templates
-- come back on the next page load (seedFlows).
PRAGMA defer_foreign_keys = ON;

DELETE FROM approvals;
DELETE FROM balance_entries;
DELETE FROM documents;
DELETE FROM entitlements;
DELETE FROM inbound_emails;
DELETE FROM messages;
DELETE FROM node_runs;
DELETE FROM payments;
DELETE FROM payouts;
DELETE FROM reservations;
DELETE FROM seller_orders;
DELETE FROM shipments;
DELETE FROM stock_movements;
DELETE FROM webhook_deliveries;
DELETE FROM webhook_receipts;
DELETE FROM orders;

DELETE FROM flow_versions;
DELETE FROM flows;

DELETE FROM contract_prices;
DELETE FROM price_rules;
DELETE FROM location_stock;
DELETE FROM products;
DELETE FROM sellers;
DELETE FROM locations;
DELETE FROM customers WHERE id <> 'cus_internal';
UPDATE customers SET balance = 0 WHERE id = 'cus_internal';
DELETE FROM fx_rates WHERE currency <> 'USD';

DELETE FROM audit_events;
DELETE FROM auth_failures;
DELETE FROM sessions WHERE user_id = 'usr_demo';
