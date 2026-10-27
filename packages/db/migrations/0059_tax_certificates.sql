-- Tax exemption certificates on customer accounts: staff add, verify and revoke them, and
-- `commerce.tax` charges no tax on an order whose customer holds one that is verified, unexpired
-- and covers the ship-to. `regions` is JSON, `[{ "country": "US", "region": "CA" }]` (no region:
-- the whole country). `expires_at` is the end of its last day in ms (UTC), null when it doesn't
-- expire. The file, when there is one, is in the documents bucket at `file_key`
-- (`customers/<customer_id>/tax-certificates/<id>`). Revoking sets `status` to 'revoked' and keeps
-- the row, for the record of which orders it exempted; erasing the customer deletes the rows and
-- their files. A new table: no existing row or reader changes.
CREATE TABLE tax_certificates (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  number TEXT NOT NULL,
  regions TEXT NOT NULL,
  expires_at INTEGER,
  file_key TEXT,
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_by TEXT,
  verified_at INTEGER,
  revoked_by TEXT,
  revoked_at INTEGER
);

CREATE INDEX tax_certificates_customer ON tax_certificates (customer_id, created_at);
