-- Who started each order (a principal id: usr_…, tok_…), so a workspace that separates duties can
-- keep them from deciding its approvals. Null for orders from channels, email and the stock review.
ALTER TABLE orders ADD COLUMN started_by TEXT;
