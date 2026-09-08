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

/** Read immutable, completed-day chart rows directly from Supabase. This is
 * deliberately kept on the legacy account: that account owns the Supabase
 * credentials, while the realtime account only requests one bounded result. */
export async function readSupabaseChartHistory(env: Env, input: {
  advertiserId: string; storeId: string; startDate: string; endDate: string;
}): Promise<{ tiktok: any[]; facebook: any[] }> {
  const config = supabaseConfig(env);
  const aliases = new Set([String(input.storeId)]);
  if (input.storeId === '749630967241416866') aliases.add('7496309672412416866');
  if (input.storeId === '7496309672412416866') aliases.add('749630967241416866');
  const range = `report_date=gte.${encodeURIComponent(input.startDate)}&report_date=lte.${encodeURIComponent(input.endDate)}`;
  const stores = [...aliases].map((value) => `store_id.eq.${value}`).join(',');
  const tiktokUrl = `${config.url}/rest/v1/tiktok_ads_daily?select=report_date,cost,gross_revenue,cost_per_order,sku_orders,aov,impressions,clicks,ctr,cr&advertiser_id=eq.${encodeURIComponent(input.advertiserId)}&or=(${stores})&${range}&order=report_date.asc`;
  const facebookUrl = `${config.url}/rest/v1/facebook_ads_daily?select=report_date,spend,gross_revenue,orders,impressions,clicks,ctr,cpm,cpc,messages,landing_page_views&${range}&order=report_date.asc`;
  const [tiktokResponse, facebookResponse] = await Promise.all([
    fetch(tiktokUrl, { headers: headers(config.key) }),
    fetch(facebookUrl, { headers: headers(config.key) })
  ]);
  if (!tiktokResponse.ok) throw new Error(`Supabase TikTok history HTTP ${tiktokResponse.status}: ${(await tiktokResponse.text()).slice(0, 300)}`);
  if (!facebookResponse.ok) throw new Error(`Supabase Facebook history HTTP ${facebookResponse.status}: ${(await facebookResponse.text()).slice(0, 300)}`);
  return { tiktok: await tiktokResponse.json<any[]>(), facebook: await facebookResponse.json<any[]>() };
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

async function upsertTable(config: { url: string; key: string }, table: string, rows: any[]): Promise<void> {
  if (!rows.length) return;
  const body = JSON.stringify(rows);
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${config.url}/rest/v1/${table}`, {
      method: 'POST', headers: headers(config.key, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }), body
    });
    if (response.ok) return;
    const details = (await response.text()).slice(0, 500);
    lastError = `Supabase table ${table} HTTP ${response.status}: ${details}`;
    // Supabase can briefly reject a freshly-issued secret JWT when its clock
    // is ahead. Retry this and other transient provider failures before
    // marking the backup partial.
    const transient = response.status >= 500 || /PGRST303|JWT issued at future|temporar|rate.?limit/i.test(details);
    if (!transient || attempt === 3) throw new Error(lastError);
    await new Promise((resolve) => setTimeout(resolve, [1000, 2500, 5000][attempt]));
  }
  throw new Error(lastError || `Supabase table ${table} failed.`);
}

async function removeLegacyCipherRows(config: { url: string; key: string }, table: string): Promise<void> {
  // Older syncs accidentally persisted the Shop API cipher (ROW_...) in the
  // store_id column. Remove only those known-invalid keys before inserting the
  // canonical numeric rows so Supabase does not retain duplicate histories.
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${config.url}/rest/v1/${table}?store_id=like.ROW_*`, {
      method: 'DELETE', headers: headers(config.key, { Prefer: 'return=minimal' })
    });
    if (response.ok) return;
    const details = (await response.text()).slice(0, 500);
    lastError = `Supabase cleanup ${table} HTTP ${response.status}: ${details}`;
    // Supabase may briefly reject a freshly issued secret JWT when its clock
    // is ahead. Treat this exactly like table upserts and retry with backoff.
    const transient = response.status >= 500 || /PGRST303|JWT issued at future|temporar|rate.?limit/i.test(details);
    if (!transient || attempt === 3) throw new Error(lastError);
    await new Promise((resolve) => setTimeout(resolve, [1000, 2500, 5000][attempt]));
  }
  throw new Error(lastError || `Supabase cleanup ${table} failed.`);
}
function tableRow(table: string, row: any): any {
  const fields: Record<string, string[]> = {
    tiktok_ads_daily: ['advertiser_id','store_id','report_date','cost','gross_revenue','cost_per_order','sku_orders','aov','impressions','clicks','ctr','cr','source','payload_json'],
    tiktok_ads_campaigns: ['advertiser_id','store_id','report_date','campaign_id','campaign_name','result','spend','gross_revenue','roas','payload_json'],
    facebook_ads_daily: ['ad_account_id','report_date','spend','gross_revenue','orders','impressions','clicks','ctr','cpm','cpc','messages','landing_page_views','roas','payload_json'],
    facebook_ads_campaigns: ['ad_account_id','report_date','campaign_id','campaign_name','result','result_type','cost_per_result','spend','reach','impressions','cpm','clicks','messages','purchases','gross_revenue','roas','payload_json']
    ,tiktok_ads_affiliate_mass_authorization: ['advertiser_id','store_id','report_date','product_id','title','cost','gross_revenue','sku_orders','impressions','clicks','payload_json']
    ,tiktok_ads_official_account: ['advertiser_id','store_id','report_date','product_id','title','cost','gross_revenue','sku_orders','impressions','clicks','payload_json']
    ,tiktok_ads_product_card: ['advertiser_id','store_id','report_date','product_id','title','cost','gross_revenue','sku_orders','impressions','clicks','payload_json']
  };
  return Object.fromEntries((fields[table] || []).filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}

async function dailySnapshot(env: Env, reportDate: string): Promise<any> {
  const [adsReports, operationsReports, orderReports, cancellations, hourlyMetrics, dailyMetrics,
    tiktokAdsDaily, tiktokAdsCampaigns, facebookAdsDaily, facebookAdsCampaigns, tiktokSources, monitorState] = await Promise.all([
    query(env, 'SELECT report_date,report_hour,status,message_id,payload,updated_at FROM scheduled_reports WHERE report_date=? ORDER BY report_hour', reportDate),
    query(env, 'SELECT report_date,report_kind,status,message_id,payload,updated_at FROM operations_bot_reports WHERE report_date=? ORDER BY report_kind', reportDate),
    query(env, 'SELECT report_date,report_time,status,message_id,payload,updated_at FROM order_bot_reports WHERE report_date=? ORDER BY report_time', reportDate),
    query(env, "SELECT cancellation_id,order_id,status,message_id,payload,created_at,updated_at FROM order_bot_cancellation_events WHERE date(updated_at,'+7 hours')=? ORDER BY updated_at", reportDate),
    query(env, 'SELECT advertiser_id,store_id,report_date,report_hour,metrics_json FROM hourly_metrics WHERE report_date=? ORDER BY report_hour', reportDate),
    query(env, 'SELECT advertiser_id,store_id,report_date,summary_json,products_json,creatives_json,created_at FROM daily_metrics WHERE report_date=?', reportDate),
    // Sync the complete accumulated history, not only today's snapshot. This
    // makes Supabase the fast read replica for the dashboard.
    query(env, 'SELECT * FROM tiktok_ads_daily ORDER BY report_date'),
    query(env, 'SELECT * FROM tiktok_ads_campaigns ORDER BY report_date'),
    query(env, 'SELECT * FROM facebook_ads_daily ORDER BY report_date'),
    query(env, 'SELECT * FROM facebook_ads_campaigns ORDER BY report_date'),
    query(env, 'SELECT * FROM tiktok_ads_source_daily ORDER BY report_date'),
    query(env, 'SELECT state_key,payload,updated_at FROM order_bot_monitor_state WHERE state_key=?', `lifecycle:${reportDate}`)
  ]);
  return { schemaVersion: 2, reportDate, generatedAt: new Date().toISOString(), source: 'cloudflare-d1',
    adsReports, operationsReports, orderReports, cancellations, hourlyMetrics, dailyMetrics,
    tiktokAdsDaily, tiktokAdsCampaigns, facebookAdsDaily, facebookAdsCampaigns, tiktokSources, monitorState };
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
    const cleanup = ['affiliate_mass_authorization','official_account','product_card']
      .map((name) => removeLegacyCipherRows(config, `tiktok_ads_${name}`));
    const cleanupResults = await Promise.allSettled(cleanup);
    const cleanupErrors = cleanupResults.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      .map((item) => String(item.reason));
    const tableWrites = [
      upsertTable(config, 'tiktok_ads_daily', current.tiktokAdsDaily.map((row:any)=>tableRow('tiktok_ads_daily',row))),
      upsertTable(config, 'tiktok_ads_campaigns', current.tiktokAdsCampaigns.map((row:any)=>tableRow('tiktok_ads_campaigns',row))),
      upsertTable(config, 'facebook_ads_daily', current.facebookAdsDaily.map((row:any)=>tableRow('facebook_ads_daily',row))),
      upsertTable(config, 'facebook_ads_campaigns', current.facebookAdsCampaigns.map((row:any)=>tableRow('facebook_ads_campaigns',row))),
      ...[['affiliate_mass_authorization','affiliate'],['official_account','seller'],['product_card','productCard']].map(([name,source])=>upsertTable(config, 'tiktok_ads_'+name, (current.tiktokSources||[]).filter((row:any)=>row.source===source).map((row:any)=>tableRow('tiktok_ads_'+name,{...row,payload_json:row.payload}))))
    ];
    const tableResults = await Promise.allSettled(tableWrites);
    const tableErrors = [...cleanupErrors, ...tableResults.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => String(item.reason))];
    await saveStatus(env, { status: tableErrors.length ? 'PARTIAL' : 'SUCCESS', startedAt, completedAt: new Date().toISOString(), bucket: config.bucket, files: [...files,...adsFiles.map(([path])=>path)], tableErrors });
  } catch (error) {
    await saveStatus(env, { status: 'FAILED', startedAt, completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
