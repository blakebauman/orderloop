-- Per-unit shipping weight and dimensions, for rating shipping by weight or dimensional weight
-- (`commerce.shipping_rate` with `basis` `weight` or `dim_weight`). Null for every existing product:
-- a unit without them falls back to the node's `defaultKg`. Written by the catalog for the variants
-- it carries them on.
ALTER TABLE products ADD COLUMN weight_kg REAL;
ALTER TABLE products ADD COLUMN length_cm REAL;
ALTER TABLE products ADD COLUMN width_cm REAL;
ALTER TABLE products ADD COLUMN height_cm REAL;
