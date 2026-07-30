CREATE TABLE IF NOT EXISTS operations_bot_reports (
  report_date TEXT NOT NULL,
  report_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_date, report_kind)
);

CREATE TABLE IF NOT EXISTS operations_bot_events (
  external_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  processed_at INTEGER
);
