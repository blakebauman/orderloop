-- The OCI control fields (~OkCode, ~TARGET, ~CALLER) a session's setup sent, checked, as JSON, so
-- the return echoes them. NULL for cXML sessions and for OCI sessions opened before this column:
-- their return uses the spec's defaults (src/oci.ts `ociControl`).
ALTER TABLE sessions ADD COLUMN oci_control TEXT;
