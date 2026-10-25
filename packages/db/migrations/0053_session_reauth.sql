-- When this session's person last signed in again at the identity provider for a step-up (single
-- sign-on with `max_age=0`, its ID token's `auth_time` checked). Null until they do; a step-up for
-- someone with no password or two-factor sign-in needs it within the last ten minutes.
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
