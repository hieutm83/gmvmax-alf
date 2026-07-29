CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_report_cache_expiry ON report_cache(expires_at);

CREATE TABLE IF NOT EXISTS daily_metrics (
  advertiser_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  products_json TEXT,
  creatives_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (advertiser_id, store_id, report_date)
);

CREATE TABLE IF NOT EXISTS hourly_metrics (
  advertiser_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  report_hour INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (advertiser_id, store_id, report_date, report_hour)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  external_id TEXT,
  received_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  result_json TEXT,
  processed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_external_id
  ON webhook_events(provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduled_reports (
  report_date TEXT NOT NULL,
  report_hour INTEGER NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_date, report_hour)
);

CREATE TABLE IF NOT EXISTS export_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  export_type TEXT NOT NULL,
  report_date TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
