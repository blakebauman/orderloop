-- Rolling an order back reverses its account charges, found by order (reverseBalance in the
-- engine's connectors). Additive: safe to apply before the Workers that use it deploy.
CREATE INDEX balance_entries_order ON balance_entries(order_id);
