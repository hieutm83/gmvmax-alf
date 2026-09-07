-- Run once in Supabase SQL Editor. The Worker then upserts these tables on
-- every scheduled snapshot while also retaining JSON files in Storage.
create table if not exists public.tiktok_ads_daily (
  advertiser_id text not null, store_id text not null, report_date date not null,
  cost numeric not null default 0, gross_revenue numeric not null default 0,
  cost_per_order numeric, sku_orders numeric not null default 0, aov numeric,
  impressions numeric not null default 0, clicks numeric not null default 0,
  ctr numeric not null default 0, cr numeric not null default 0, source text not null,
  payload_json jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(),
  primary key (advertiser_id, store_id, report_date)
);
create index if not exists tiktok_ads_daily_date_idx on public.tiktok_ads_daily(report_date);

create table if not exists public.tiktok_ads_campaigns (
  advertiser_id text not null, store_id text not null, report_date date not null,
  campaign_id text not null, campaign_name text, result numeric not null default 0,
  spend numeric not null default 0, gross_revenue numeric not null default 0, roas numeric,
  payload_json jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(),
  primary key (advertiser_id, store_id, report_date, campaign_id)
);
create index if not exists tiktok_ads_campaigns_date_idx on public.tiktok_ads_campaigns(report_date);

create table if not exists public.facebook_ads_daily (
  ad_account_id text not null, report_date date not null, spend numeric not null default 0,
  gross_revenue numeric not null default 0, orders numeric not null default 0,
  impressions numeric not null default 0, clicks numeric not null default 0,
  ctr numeric not null default 0, cpm numeric not null default 0, cpc numeric not null default 0,
  messages numeric not null default 0, landing_page_views numeric not null default 0,
  roas numeric, payload_json jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(),
  primary key (ad_account_id, report_date)
);
create index if not exists facebook_ads_daily_date_idx on public.facebook_ads_daily(report_date);

create table if not exists public.facebook_ads_campaigns (
  ad_account_id text not null, report_date date not null, campaign_id text not null,
  campaign_name text, result numeric not null default 0, result_type text,
  cost_per_result numeric, spend numeric not null default 0, reach numeric not null default 0,
  impressions numeric not null default 0, cpm numeric not null default 0, clicks numeric not null default 0,
  messages numeric not null default 0, purchases numeric not null default 0,
  gross_revenue numeric not null default 0, roas numeric,
  payload_json jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(),
  primary key (ad_account_id, report_date, campaign_id)
);
create index if not exists facebook_ads_campaigns_date_idx on public.facebook_ads_campaigns(report_date);
