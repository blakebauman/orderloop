-- Where an order waits and since when, so lists can say which step it is held at and for how long.
ALTER TABLE orders ADD COLUMN waiting_at TEXT;
ALTER TABLE orders ADD COLUMN waiting_since INTEGER;
