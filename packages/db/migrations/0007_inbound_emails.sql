-- Every message that reaches the email() entrypoint, accepted or not, for the back office's intake
-- log. The Message-ID is unique so a redelivered message is recorded once.
CREATE TABLE inbound_emails (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reason TEXT,
  order_id TEXT,
  r2_key TEXT,
  attachments INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inbound_emails_message ON inbound_emails(message_id);
CREATE INDEX inbound_emails_received ON inbound_emails(received_at);
