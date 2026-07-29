CREATE TABLE IF NOT EXISTS video_jobs (
  event_id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  contexts_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS video_job_days (
  event_id INTEGER NOT NULL,
  report_date TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, report_date),
  FOREIGN KEY (event_id) REFERENCES video_jobs(event_id) ON DELETE CASCADE
);

