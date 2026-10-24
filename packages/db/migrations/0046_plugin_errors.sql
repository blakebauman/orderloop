-- The latest exceptions of each sandboxed plugin, from its Tail Worker (PluginTail in the
-- engine's plugin-host.ts), scrubbed of its secrets; the Plugins page lists them. At most 100 per
-- plugin are kept. Additive: safe to apply before the Workers that use it deploy.
CREATE TABLE plugin_errors (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX plugin_errors_plugin ON plugin_errors(plugin_id, at);
