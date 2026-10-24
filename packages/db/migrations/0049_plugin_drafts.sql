-- Plugins the assistant drafts for an admin (docs/plugins.md, "Assistant-drafted plugins"): the
-- admin's instruction, and the draft's test cases with their last results (JSON). Both null for a
-- plugin uploaded from a file. Additive: safe to apply before the Workers that use it deploy.
ALTER TABLE installed_plugins ADD COLUMN request TEXT;
ALTER TABLE installed_plugins ADD COLUMN cases TEXT;
-- A version names one bundle: two drafts (or uploads) can't both be version 3 of a plugin.
CREATE UNIQUE INDEX installed_plugins_version ON installed_plugins(id, version);
