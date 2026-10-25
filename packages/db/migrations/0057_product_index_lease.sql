-- Who is running the product index's reindex, and until when: the hourly cron and an admin's
-- "Update product index" take this one row before they start, so two runs never embed and write
-- the same SKUs at once. A row past `expires_at` is free (a run that died leaves it to lapse).
-- Empty at first: the next reindex takes it.
CREATE TABLE product_index_lease (
  id INTEGER PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
