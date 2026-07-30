CREATE TABLE IF NOT EXISTS nhanh_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT,
  external_id TEXT,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nhanh_webhook_events_received
  ON nhanh_webhook_events(received_at DESC);
