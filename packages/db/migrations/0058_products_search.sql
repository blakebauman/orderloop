-- Keyword search over `products` (SKU and name), for finding a product to add to a cart: the
-- engine's `searchCartProducts` matches it with core's `ftsQuery`, as the catalog's search does.
-- An external-content index: it holds only the terms, reading SKU and name from `products` by
-- rowid, so nothing is stored twice, and `INSERT INTO products_search(products_search)
-- VALUES('rebuild')` remakes it from `products` whenever it is in doubt (it is how it is filled
-- here). `products` has several writers (the catalog's listing changes, seeds, the demo reset,
-- stock moves), so triggers keep it current rather than each writer; an update reindexes a row
-- only when its SKU or name actually changes, so stock, price and reservation writes (and the
-- catalog's upserts, which always set the name) leave it alone. Ranked by BM25 weighting SKU 8 and
-- name 10, set once here (`rank`), with prefix indexes for the two- and three-character prefixes
-- `ftsQuery` asks for as someone types.
--
-- D1 can't export a database with a virtual table: drop this one before `wrangler d1 export` and
-- recreate it after (docs/operations.md, "Removing a customer").
CREATE VIRTUAL TABLE products_search USING fts5(
  sku,
  name,
  content = 'products',
  content_rowid = 'rowid',
  prefix = '2 3',
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO products_search (products_search, rank) VALUES ('rank', 'bm25(8.0, 10.0)');

INSERT INTO products_search (products_search) VALUES ('rebuild');

CREATE TRIGGER products_search_insert AFTER INSERT ON products
BEGIN
  INSERT INTO products_search (rowid, sku, name) VALUES (new.rowid, new.sku, new.name);
END;

CREATE TRIGGER products_search_update AFTER UPDATE OF sku, name ON products
WHEN old.sku IS NOT new.sku OR old.name IS NOT new.name
BEGIN
  INSERT INTO products_search (products_search, rowid, sku, name)
    VALUES ('delete', old.rowid, old.sku, old.name);
  INSERT INTO products_search (rowid, sku, name) VALUES (new.rowid, new.sku, new.name);
END;

CREATE TRIGGER products_search_delete AFTER DELETE ON products
BEGIN
  INSERT INTO products_search (products_search, rowid, sku, name)
    VALUES ('delete', old.rowid, old.sku, old.name);
END;
