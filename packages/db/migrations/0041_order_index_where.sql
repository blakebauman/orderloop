-- Where an order is, for the orders list: what its open waits are on (a person's role, a business
-- event or a timer), and for an order that ended badly, the step it stopped at and why. Written by
-- each order's agent; null on rows it hasn't re-indexed since.
ALTER TABLE orders ADD COLUMN waiting_for TEXT;
ALTER TABLE orders ADD COLUMN stopped_at TEXT;
ALTER TABLE orders ADD COLUMN reason TEXT;
