-- Keyword search over `products` (SKU and name), for finding a product to add to a cart: the
-- engine's `searchCartProducts` matches it with core's `ftsQuery`, as the catalog's search does.
-- `products` has several writers (the catalog's listing changes, seeds, the demo reset, stock
-- moves), so triggers keep the index current rather than each writer. Its rowid is the product
-- row's; an update reindexes the row only when its SKU or name changes, so stock and reservation
-- writes never touch it. Filled from the rows that exist now.
CREATE VIRTUAL TABLE products_search USING fts5(sku, name, tokenize = 'unicode61 remove_diacritics 2');

INSERT INTO products_search (rowid, sku, name) SELECT rowid, sku, name FROM products;

CREATE TRIGGER products_search_insert AFTER INSERT ON products
BEGIN
  INSERT INTO products_search (rowid, sku, name) VALUES (new.rowid, new.sku, new.name);
END;

CREATE TRIGGER products_search_update AFTER UPDATE OF sku, name ON products
BEGIN
  DELETE FROM products_search WHERE rowid = old.rowid;
  INSERT INTO products_search (rowid, sku, name) VALUES (new.rowid, new.sku, new.name);
END;

CREATE TRIGGER products_search_delete AFTER DELETE ON products
BEGIN
  DELETE FROM products_search WHERE rowid = old.rowid;
END;
