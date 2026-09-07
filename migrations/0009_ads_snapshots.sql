-- Fast, durable snapshots for the dashboard and Supabase backups.
CREATE TABLE IF NOT EXISTS tiktok_ads_daily (
  advertiser_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  gross_revenue REAL NOT NULL DEFAULT 0,
  cost_per_order REAL,
  sku_orders REAL NOT NULL DEFAULT 0,
  aov REAL,
  impressions REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  cr REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'mcp-report',
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (advertiser_id, store_id, report_date)
);
CREATE INDEX IF NOT EXISTS idx_tiktok_ads_daily_date ON tiktok_ads_daily(report_date);

CREATE TABLE IF NOT EXISTS tiktok_ads_campaigns (
  advertiser_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  objective TEXT,
  result REAL NOT NULL DEFAULT 0,
  cost_per_result REAL,
  spend REAL NOT NULL DEFAULT 0,
  reach REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  cpm REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  link_clicks REAL NOT NULL DEFAULT 0,
  landing_page_views REAL NOT NULL DEFAULT 0,
  messages REAL NOT NULL DEFAULT 0,
  leads REAL NOT NULL DEFAULT 0,
  app_installs REAL NOT NULL DEFAULT 0,
  purchases REAL NOT NULL DEFAULT 0,
  gross_revenue REAL NOT NULL DEFAULT 0,
  roas REAL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (advertiser_id, store_id, report_date, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_tiktok_ads_campaigns_date ON tiktok_ads_campaigns(report_date);

CREATE TABLE IF NOT EXISTS facebook_ads_daily (
  ad_account_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  spend REAL NOT NULL DEFAULT 0,
  gross_revenue REAL NOT NULL DEFAULT 0,
  orders REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  cpm REAL NOT NULL DEFAULT 0,
  cpc REAL NOT NULL DEFAULT 0,
  messages REAL NOT NULL DEFAULT 0,
  landing_page_views REAL NOT NULL DEFAULT 0,
  roas REAL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ad_account_id, report_date)
);
CREATE INDEX IF NOT EXISTS idx_facebook_ads_daily_date ON facebook_ads_daily(report_date);

CREATE TABLE IF NOT EXISTS facebook_ads_campaigns (
  ad_account_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  objective TEXT,
  result REAL NOT NULL DEFAULT 0,
  result_type TEXT,
  cost_per_result REAL,
  spend REAL NOT NULL DEFAULT 0,
  reach REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  cpm REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  link_clicks REAL NOT NULL DEFAULT 0,
  landing_page_views REAL NOT NULL DEFAULT 0,
  messages REAL NOT NULL DEFAULT 0,
  leads REAL NOT NULL DEFAULT 0,
  app_installs REAL NOT NULL DEFAULT 0,
  purchases REAL NOT NULL DEFAULT 0,
  gross_revenue REAL NOT NULL DEFAULT 0,
  roas REAL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ad_account_id, report_date, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_facebook_ads_campaigns_date ON facebook_ads_campaigns(report_date);
