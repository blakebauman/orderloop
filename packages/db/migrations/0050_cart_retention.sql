-- Retention and erasure for carts. Both null for every existing cart.
--
-- buyer_id: an external cart's buyer as the plugin named them (lower-cased; a punchout buyer's is
-- their email when their system sends one), so a data subject request finds the carts they were
-- admitted to. Written by the cart's agent.
-- purged_at: when the retention sweep cleared an ended cart's chat, files and buyer; the cart's
-- lines and quote stay.
ALTER TABLE carts ADD COLUMN buyer_id TEXT;
ALTER TABLE carts ADD COLUMN purged_at INTEGER;
CREATE INDEX carts_buyer ON carts(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE INDEX carts_purge ON carts(purged_at, updated_at);
