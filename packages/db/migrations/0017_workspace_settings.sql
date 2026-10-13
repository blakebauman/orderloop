-- Workspace settings operators change in the app, such as which roles must use two-factor sign-in.
CREATE TABLE workspace_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
