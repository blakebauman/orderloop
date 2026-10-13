-- A replayed Idempotency-Key must carry the same request; a different one is answered 422.
-- Rows from before this migration have no fingerprint and replay without the check.
ALTER TABLE orders ADD COLUMN idempotency_fingerprint TEXT;
