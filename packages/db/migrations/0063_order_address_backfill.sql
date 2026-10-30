-- Marks the orders whose ship-to the customer page's addresses (`customer_addresses`, 0062)
-- haven't counted: those with a customer, not erased, that started before the first address was
-- kept. Every order counted since started at or after its address's `first_used_at`, so none is
-- marked twice; with no address kept yet, every such order is marked. Their ship-to lives only in
-- each order's agent state: the engine's daily sweep reads each marked order's agent, adds its
-- address and clears the mark (`backfillAddresses`). Orders started from now are null. A new
-- column, null for every other order: no existing reader changes.
ALTER TABLE orders ADD COLUMN address_pending INTEGER;

UPDATE orders SET address_pending = 1
WHERE customer_id IS NOT NULL
  AND erased_at IS NULL
  AND created_at < COALESCE((SELECT min(first_used_at) FROM customer_addresses), 9007199254740991);

CREATE INDEX orders_address_pending ON orders (address_pending) WHERE address_pending IS NOT NULL;
