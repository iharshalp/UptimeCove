-- Phase 0: performance indexes.
--
-- NOTE: monitors.check_claimed_until and monitors.check_claim_token are defined
-- directly in 0001_init.sql. The `ALTER TABLE monitors ADD COLUMN ...` statements
-- that used to live here were removed because they fail with
-- "duplicate column name" on a fresh database (the column already exists after
-- 0001). The index statements below are idempotent (IF NOT EXISTS), so this
-- migration is a safe no-op on databases that already applied the original 0001.
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks (checked_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_incident ON incidents (monitor_id) WHERE resolved_at IS NULL;
