CREATE TABLE IF NOT EXISTS dashboard_login_attempts (
  fingerprint TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboard_login_blocked_until ON dashboard_login_attempts(blocked_until);
