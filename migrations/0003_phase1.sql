-- Phase 1: rich monitors, notifications, incidents, maintenance, status pages, sessions
ALTER TABLE monitors ADD COLUMN body_must_contain TEXT;
ALTER TABLE monitors ADD COLUMN body_must_not_contain TEXT;
ALTER TABLE monitors ADD COLUMN max_response_time_ms INTEGER;
ALTER TABLE monitors ADD COLUMN custom_headers TEXT;
ALTER TABLE monitors ADD COLUMN check_regions TEXT;

ALTER TABLE status_pages ADD COLUMN description TEXT;
ALTER TABLE status_pages ADD COLUMN branding_logo_url TEXT;
ALTER TABLE status_pages ADD COLUMN branding_theme TEXT;
ALTER TABLE status_pages ADD COLUMN custom_domain TEXT;
ALTER TABLE status_pages ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  status_page_id INTEGER REFERENCES status_pages(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_window_time ON maintenance_windows(start_at, end_at);

CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
  monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_time ON notification_deliveries(created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(status_page_id, email)
);

CREATE TABLE IF NOT EXISTS heartbeat_monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL UNIQUE REFERENCES monitors(id) ON DELETE CASCADE,
  grace_seconds INTEGER NOT NULL DEFAULT 300,
  last_ping_at INTEGER
);
