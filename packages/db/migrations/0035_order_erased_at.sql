-- When a data subject erasure removed the buyer from an order (apps/engine/src/subjects.ts), so a
-- repeated or continued erasure skips it.
ALTER TABLE orders ADD COLUMN erased_at INTEGER;
