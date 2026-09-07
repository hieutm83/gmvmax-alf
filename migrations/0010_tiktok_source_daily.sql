CREATE TABLE IF NOT EXISTS tiktok_ads_source_daily (
  advertiser_id TEXT NOT NULL, store_id TEXT NOT NULL, report_date TEXT NOT NULL,
  source TEXT NOT NULL, product_id TEXT NOT NULL, title TEXT,
  cost REAL NOT NULL DEFAULT 0, gross_revenue REAL NOT NULL DEFAULT 0,
  sku_orders REAL NOT NULL DEFAULT 0, impressions REAL NOT NULL DEFAULT 0, clicks REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (advertiser_id,store_id,report_date,source,product_id)
);
CREATE INDEX IF NOT EXISTS idx_tiktok_ads_source_daily_date ON tiktok_ads_source_daily(report_date);
