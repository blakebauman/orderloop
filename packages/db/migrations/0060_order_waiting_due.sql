-- When an order's soonest open wait times out (its step's deadline), so lists can tell a wait that
-- is overdue from one that is on time. Null for a timer, and on rows the agent hasn't re-indexed
-- since; a null is never overdue.
ALTER TABLE orders ADD COLUMN waiting_due INTEGER;
