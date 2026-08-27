-- Phase 3: advanced checks, on-call, postmortems, analytics
ALTER TABLE monitors ADD COLUMN monitor_type TEXT NOT NULL DEFAULT 'http';
ALTER TABLE monitors ADD COLUMN tls_expiry_threshold_days INTEGER;
ALTER TABLE monitors ADD COLUMN dns_expected_value TEXT;
ALTER TABLE monitors ADD COLUMN tcp_port INTEGER;
ALTER TABLE monitors ADD COLUMN synthetic_steps TEXT;

CREATE TABLE IF NOT EXISTS on_call_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT,
  rotation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escalation_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_postmortems (
  id TEXT PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  action_items TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  wrangler_config TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO deployment_templates (id, name, description, wrangler_config, created_at) VALUES ('tpl-cloudflare', 'Cloudflare Workers', 'Standard Cloudflare deployment with D1 and KV', '{"d1_databases":[{"binding":"DB","database_name":"uptimecove-db"}],"kv_namespaces":[{"binding":"CACHE"}]}', unixepoch());
