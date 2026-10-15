-- Who published each flow version, as the audit trail names them. Null for built-in templates
-- and versions published before this was recorded.
ALTER TABLE flow_versions ADD COLUMN published_by TEXT;
