-- POST /api/v1/orders with an Idempotency-Key returns the order that key already created.
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX orders_idempotency ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
