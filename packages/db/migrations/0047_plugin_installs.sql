-- Sandboxed plugins an admin installed at runtime from a signed bundle (docs/plugins.md,
-- "Installing at runtime"): one row per uploaded version, keyed by the bundle's sha. At most one
-- row per plugin is active or disabled; earlier versions are superseded, kept for rollback.
-- Additive: safe to apply before the Workers that use it deploy.
CREATE TABLE installed_plugins (
  id TEXT NOT NULL,
  sha TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  manifest TEXT NOT NULL,
  status TEXT NOT NULL,
  personal_data_granted INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  PRIMARY KEY (id, sha)
);
CREATE INDEX installed_plugins_status ON installed_plugins(status);
-- At most one version of a plugin runs (or is turned off) at a time.
CREATE UNIQUE INDEX installed_plugins_running ON installed_plugins(id)
  WHERE status IN ('active', 'disabled');

-- Secrets an admin entered for a runtime-installed plugin, sealed with DATA_KEY (context
-- plugin_secrets:<plugin>:<name>) and resealed by the daily sweep. Write-only: never shown again.
CREATE TABLE plugin_secrets (
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
