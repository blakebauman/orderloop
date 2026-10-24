-- A shipment a provider plugin labelled (a node's Provider field): which plugin, and its own id
-- for the label, so a rollback or a cancelled order voids it there. Null for built-in shipments.
-- Additive: safe to apply before the Workers that use it deploy.
ALTER TABLE shipments ADD COLUMN provider TEXT;
ALTER TABLE shipments ADD COLUMN external_id TEXT;
