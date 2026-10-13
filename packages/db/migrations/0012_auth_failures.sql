-- Failed sign-ins and shared-password API attempts, counted per key in fixed 15-minute windows
-- (keys like "ip:<addr>", "email:<addr>", "email-ip:<addr>|<ip>"), so guessing is throttled
-- before any password is checked.
CREATE TABLE auth_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
