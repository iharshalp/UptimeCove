-- UptimeCove schema
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  expected_status INTEGER NOT NULL DEFAULT 200,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  enabled INTEGER NOT NULL DEFAULT 1,
  current_status TEXT NOT NULL DEFAULT 'pending',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  check_claimed_until INTEGER,
  check_claim_token TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  error TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_time ON checks (monitor_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents (monitor_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_incident ON incidents (monitor_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks (checked_at);

CREATE TABLE IF NOT EXISTS status_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_page_monitors (
  page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, monitor_id)
);

INSERT OR IGNORE INTO status_pages (id, slug, title, created_at)
VALUES (1, 'default', 'UptimeCove Status', unixepoch());
