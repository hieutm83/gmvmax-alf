import type { Env } from './types';
import { shiftDate } from './utils';

const DEFAULT_BUCKET = 'gmv-max-monitoring';

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeRows(rows: any[]): any[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, key.endsWith('payload') || key.endsWith('_json') ? jsonValue(value) : value])));
}

async function query(env: Env, sql: string, ...values: unknown[]): Promise<any[]> {
  const result = await env.DB.prepare(sql).bind(...values).all<any>();
  return normalizeRows(result.results || []);
}

function supabaseConfig(env: Env): { url: string; key: string; bucket: string } {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || '');
  if (!url || !key) throw new Error('Supabase backup is not configured.');
  return { url, key, bucket: env.SUPABASE_BACKUP_BUCKET || DEFAULT_BUCKET };
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function ensureBucket(env: Env): Promise<{ url: string; key: string; bucket: string }> {
  const config = supabaseConfig(env);
  const response = await fetch(`${config.url}/storage/v1/bucket`, {
    method: 'POST', headers: headers(config.key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: config.bucket, name: config.bucket, public: false })
  });
  if (!response.ok) {
    const details = await response.text();
    if (response.status !== 409 && !/already exists|duplicate/i.test(details)) {
      throw new Error(`Supabase bucket HTTP ${response.status}: ${details.slice(0, 300)}`);
    }
  }
  return config;
}

export function supabaseObjectUrl(url: string, bucket: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${url.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

async function uploadJson(config: { url: string; key: string; bucket: string }, path: string, value: unknown): Promise<void> {
  const response = await fetch(supabaseObjectUrl(config.url, config.bucket, path), {
    method: 'POST', headers: headers(config.key, { 'Content-Type': 'application/json; charset=utf-8', 'x-upsert': 'true' }),
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error(`Supabase upload ${path} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function dailySnapshot(env: Env, reportDate: string): Promise<any> {
  const [adsReports, operationsReports, orderReports, cancellations, hourlyMetrics, dailyMetrics,
    tiktokAdsDaily, tiktokAdsCampaigns, facebookAdsDaily, facebookAdsCampaigns, monitorState] = await Promise.all([
    query(env, 'SELECT report_date,report_hour,status,message_id,payload,updated_at FROM scheduled_reports WHERE report_date=? ORDER BY report_hour', reportDate),
    query(env, 'SELECT report_date,report_kind,status,message_id,payload,updated_at FROM operations_bot_reports WHERE report_date=? ORDER BY report_kind', reportDate),
    query(env, 'SELECT report_date,report_time,status,message_id,payload,updated_at FROM order_bot_reports WHERE report_date=? ORDER BY report_time', reportDate),
    query(env, "SELECT cancellation_id,order_id,status,message_id,payload,created_at,updated_at FROM order_bot_cancellation_events WHERE date(updated_at,'+7 hours')=? ORDER BY updated_at", reportDate),
    query(env, 'SELECT advertiser_id,store_id,report_date,report_hour,metrics_json FROM hourly_metrics WHERE report_date=? ORDER BY report_hour', reportDate),
    query(env, 'SELECT advertiser_id,store_id,report_date,summary_json,products_json,creatives_json,created_at FROM daily_metrics WHERE report_date=?', reportDate),
    query(env, 'SELECT * FROM tiktok_ads_daily WHERE report_date=?', reportDate),
    query(env, 'SELECT * FROM tiktok_ads_campaigns WHERE report_date=?', reportDate),
    query(env, 'SELECT * FROM facebook_ads_daily WHERE report_date=?', reportDate),
    query(env, 'SELECT * FROM facebook_ads_campaigns WHERE report_date=?', reportDate),
    query(env, 'SELECT state_key,payload,updated_at FROM order_bot_monitor_state WHERE state_key=?', `lifecycle:${reportDate}`)
  ]);
  return { schemaVersion: 2, reportDate, generatedAt: new Date().toISOString(), source: 'cloudflare-d1',
    adsReports, operationsReports, orderReports, cancellations, hourlyMetrics, dailyMetrics,
    tiktokAdsDaily, tiktokAdsCampaigns, facebookAdsDaily, facebookAdsCampaigns, monitorState };
}

async function monitoringSnapshot(env: Env, reportDate: string): Promise<any> {
  const [ads, operations, orders, invalid] = await Promise.all([
    query(env, 'SELECT report_date,report_hour,status,message_id,updated_at FROM scheduled_reports ORDER BY report_date DESC,report_hour DESC LIMIT 30'),
    query(env, 'SELECT report_date,report_kind,status,message_id,updated_at FROM operations_bot_reports ORDER BY updated_at DESC LIMIT 15'),
    query(env, 'SELECT report_date,report_time,status,message_id,updated_at FROM order_bot_reports ORDER BY report_date DESC,report_time DESC LIMIT 30'),
    query(env, `SELECT 'ADS' AS bot,report_date||' '||report_hour AS slot,status,updated_at,payload FROM scheduled_reports WHERE status<>'SENT'
      UNION ALL SELECT 'OPERATIONS',report_date||' '||report_kind,status,updated_at,payload FROM operations_bot_reports WHERE status<>'SENT'
      UNION ALL SELECT 'ORDER',report_date||' '||report_time,status,updated_at,payload FROM order_bot_reports WHERE status<>'SENT'
      ORDER BY updated_at DESC LIMIT 50`)
  ]);
  return { schemaVersion: 1, reportDate, generatedAt: new Date().toISOString(), timezone: env.TIMEZONE,
    health: invalid.some((row) => ['FAILED','SENDING'].includes(String(row.status))) ? 'ATTENTION' : 'OK', ads, operations, orders, exceptions: invalid };
}

async function saveStatus(env: Env, value: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES('SUPABASE_BACKUP_STATUS',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(JSON.stringify(value)).run();
}

export async function syncSupabaseBackup(env: Env, reportDate: string): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const config = await ensureBucket(env);
    const previousDate = shiftDate(reportDate, -1);
    const [current, previous, monitoring] = await Promise.all([
      dailySnapshot(env, reportDate), dailySnapshot(env, previousDate), monitoringSnapshot(env, reportDate)
    ]);
    const files = [`daily/${reportDate}.json`, `daily/${previousDate}.json`, 'monitoring/latest.json'];
    const adsFiles = [
      [`ads/tiktok/daily/${reportDate}.json`, current.tiktokAdsDaily],
      [`ads/tiktok/campaigns/${reportDate}.json`, current.tiktokAdsCampaigns],
      [`ads/facebook/daily/${reportDate}.json`, current.facebookAdsDaily],
      [`ads/facebook/campaigns/${reportDate}.json`, current.facebookAdsCampaigns]
    ] as Array<[string, unknown]>;
    await Promise.all([
      uploadJson(config, files[0], current), uploadJson(config, files[1], previous), uploadJson(config, files[2], monitoring),
      ...adsFiles.map(([path,value])=>uploadJson(config,path,{schemaVersion:1,reportDate,generatedAt:new Date().toISOString(),rows:value||[]}))
    ]);
    await saveStatus(env, { status: 'SUCCESS', startedAt, completedAt: new Date().toISOString(), bucket: config.bucket, files: [...files,...adsFiles.map(([path])=>path)] });
  } catch (error) {
    await saveStatus(env, { status: 'FAILED', startedAt, completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
