-- Orders carry a commerce model and the channel they came in on, instead of one order type.
ALTER TABLE flows RENAME COLUMN order_type TO model;
ALTER TABLE flows ADD COLUMN channels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orders RENAME COLUMN type TO model;
ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'api';
ALTER TABLE orders ADD COLUMN external_id TEXT;
ALTER TABLE orders ADD COLUMN contact_email TEXT;
ALTER TABLE node_runs RENAME COLUMN order_type TO model;
ALTER TABLE customers ADD COLUMN kind TEXT NOT NULL DEFAULT 'business';

UPDATE flows SET model = CASE model
  WHEN 'purchase_request' THEN 'procurement'
  WHEN 'b2b_order' THEN 'b2b'
  WHEN 'reorder' THEN 'replenishment'
  WHEN 'storefront_order' THEN 'b2c'
  ELSE model END;
UPDATE flows SET channels = CASE model
  WHEN 'procurement' THEN '["manual","email","api"]'
  WHEN 'b2b' THEN '["email","api","manual"]'
  WHEN 'replenishment' THEN '["schedule","manual"]'
  ELSE '["web","mobile","api"]' END;

UPDATE flow_versions SET flow_json = json_remove(
  json_set(flow_json,
    '$.model', CASE json_extract(flow_json, '$.orderType')
      WHEN 'purchase_request' THEN 'procurement'
      WHEN 'b2b_order' THEN 'b2b'
      WHEN 'reorder' THEN 'replenishment'
      WHEN 'storefront_order' THEN 'b2c'
      ELSE json_extract(flow_json, '$.orderType') END,
    '$.channels', json((SELECT channels FROM flows WHERE flows.id = flow_versions.flow_id))),
  '$.orderType')
WHERE json_extract(flow_json, '$.orderType') IS NOT NULL;

UPDATE orders SET channel = CASE
  WHEN idempotency_key LIKE 'email:%' THEN 'email'
  WHEN model = 'reorder' THEN 'schedule'
  WHEN model IN ('storefront_order', 'subscription') THEN 'web'
  WHEN idempotency_key IS NOT NULL THEN 'api'
  ELSE 'manual' END;
UPDATE orders SET model = CASE model
  WHEN 'purchase_request' THEN 'procurement'
  WHEN 'b2b_order' THEN 'b2b'
  WHEN 'reorder' THEN 'replenishment'
  WHEN 'storefront_order' THEN 'b2c'
  ELSE model END;
UPDATE node_runs SET model = CASE model
  WHEN 'purchase_request' THEN 'procurement'
  WHEN 'b2b_order' THEN 'b2b'
  WHEN 'reorder' THEN 'replenishment'
  WHEN 'storefront_order' THEN 'b2c'
  ELSE model END;

DROP INDEX orders_type;
CREATE INDEX orders_model ON orders(model, updated_at);
CREATE INDEX orders_channel_external ON orders(channel, external_id) WHERE external_id IS NOT NULL;

UPDATE customers SET kind = 'consumer' WHERE tier = 'consumer';
UPDATE customers SET kind = 'internal' WHERE tier = 'internal';
