-- SCIM provisioning (apps/web/app/lib/scim.server.ts): the identity provider's own id for a
-- person, and the groups it pushes with their members. Admins map groups to roles; a person's
-- role follows the highest role among their mapped groups.
ALTER TABLE users ADD COLUMN scim_external_id TEXT;
CREATE TABLE scim_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE scim_group_members (
  group_id TEXT NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members(user_id);
