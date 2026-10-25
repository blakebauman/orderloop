-- What the product index (Vectorize, PRODUCT_VECTORS) holds: one row per SKU whose embedding was
-- written, with the name it was made from. The engine's reindex compares it with `products` to
-- embed new and renamed SKUs and to delete the vectors of SKUs that are gone, whichever writer
-- (the catalog, a seed, a reset) changed them. Empty at first: the next reindex fills it.
CREATE TABLE product_vectors (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
