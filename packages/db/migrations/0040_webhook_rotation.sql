-- Rotating an outbound webhook subscription's signing secret: deliveries are signed with both the
-- new secret and the one before it until previous_expires_at, so the receiver can switch over.
ALTER TABLE webhook_subscriptions ADD COLUMN previous_secret TEXT;
ALTER TABLE webhook_subscriptions ADD COLUMN previous_expires_at INTEGER;
