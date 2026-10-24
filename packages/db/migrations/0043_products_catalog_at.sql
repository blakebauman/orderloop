-- The product catalog keeps each variant's name and list price here (apps/catalog, orders.ts).
-- Its changes can arrive out of order, so it records when it last wrote a row and only a newer
-- change applies. Null for rows the catalog never wrote.
ALTER TABLE products ADD COLUMN catalog_at INTEGER;
