CREATE TABLE IF NOT EXISTS order_bot_reports (
  report_date TEXT NOT NULL,
  report_time TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_date, report_time)
);
