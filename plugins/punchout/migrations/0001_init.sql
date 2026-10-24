-- Procurement systems allowed to punch out to this deployment, and the sessions they opened.
--
-- partners: one per buyer system and protocol. A cXML partner is found by its From credential
-- (from_domain, identity) and proves itself with the Sender's SharedSecret; an OCI partner by its
-- USERNAME, with its PASSWORD. Only the secret's SHA-256 is kept (shown once when made). Returns
-- go only to a BrowserFormPost / HOOK_URL on one of return_hosts (a JSON array of host names).
CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  from_domain TEXT NOT NULL DEFAULT '',
  identity TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  supplier_domain TEXT NOT NULL DEFAULT 'NetworkID',
  supplier_identity TEXT NOT NULL DEFAULT 'orderloop',
  customer_id TEXT,
  flow_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'b2b',
  return_hosts TEXT NOT NULL DEFAULT '[]',
  frame_origins TEXT NOT NULL DEFAULT '[]',
  session_minutes INTEGER NOT NULL DEFAULT 120,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX partners_identity ON partners(protocol, from_domain, identity);

-- One per cart a partner's session opened: how to send it back.
CREATE TABLE sessions (
  cart_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  buyer_cookie TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
