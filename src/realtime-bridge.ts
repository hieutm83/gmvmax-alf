import type { Env } from './types';
import { json, numberValue, shiftDate, validateDate } from './utils';
import { createAuthorizationUrl, disconnect, handleOAuthCallback, oauthConnectionState, readTokens, refreshAccessToken } from './oauth';
import { createSellerAuthorizationUrl, disconnectSeller, handleSellerOAuthCallback, loadSellerRevenueAnalysis } from './seller';
import { sellerOAuthState } from './seller';
import { createSession, listAdvertisers, listStores } from './mcp';
import { dateInTimezone } from './utils';
import { saveTikTokAdsSnapshot, saveFacebookAdsSnapshot } from './ads-snapshots';
import { decryptJson, decryptTokens, encryptJson, encryptTokens } from './crypto';
import type { SellerTokenSet } from './types';
import { loadMainReport } from './reports';
import { loadComparison, loadCreativeSummaries, loadProductVideos, loadVideoMetadata, loadVideoStats } from './reports';
import { loadFacebookAdsReport } from './facebook';
import { loadAdsTrafficTimeline, loadCAdsReport } from './cads';
import { loadOperationsAnalysis } from './operations';
import { loadFinanceAnalysis } from './finance';
import { loadContentKocAnalysis } from './content-koc';
import { loadKocAnalysis } from './koc-analysis';
import { loadProductAnalysis } from './product-analysis';
import { readSupabaseChartHistory } from './supabase-backup';

function emptyTikTok() { return { cost: 0, orders: 0, grossRevenue: 0, traffic: 0, trafficAvailable: true, costPerOrder: null, roi: null }; }
function addTikTok(target: any, row: any): void {
  target.cost += numberValue(row.cost); target.orders += numberValue(row.sku_orders);
  target.grossRevenue += numberValue(row.gross_revenue); target.traffic += numberValue(row.clicks);
  target.costPerOrder = target.orders ? target.cost / target.orders : null;
  target.roi = target.cost ? target.grossRevenue / target.cost : null;
}
function days(start: string, end: string): string[] { const out: string[] = []; for (let d = start; d <= end; d = shiftDate(d, 1)) out.push(d); return out; }

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
}

/** Re-encrypt the already-replicated OAuth grants with the new account's
 * encryption key. The legacy Worker only decrypts ciphertext supplied by the
 * new D1; it does not read the legacy D1, so this also works while the old D1
 * row-read quota is exhausted. */
export async function ensureRuntimeCredentials(env: Env): Promise<void> {
  if (!env.TOKEN_ENCRYPTION_KEY || !env.REALTIME_SOURCE_URL || !env.REALTIME_BRIDGE_SECRET) return;
  const rows = await env.DB.prepare("SELECT key,value FROM app_settings WHERE key IN ('oauth_tokens','seller_oauth_tokens')").all<any>();
  const values = new Map((rows.results || []).map((row: any) => [String(row.key), String(row.value || '')]));
  const oauthCipher = values.get('oauth_tokens') || '';
  const sellerCipher = values.get('seller_oauth_tokens') || '';
  let oauthValid = !oauthCipher; let sellerValid = !sellerCipher;
  if (oauthCipher) { try { await decryptTokens(env, oauthCipher); oauthValid = true; } catch { /* legacy key */ } }
  if (sellerCipher) { try { await decryptJson<SellerTokenSet>(env, sellerCipher); sellerValid = true; } catch { /* legacy key */ } }
  if (oauthValid && sellerValid) return;
  const response = await fetch(`${env.REALTIME_SOURCE_URL.replace(/\/$/, '')}/internal/realtime`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Realtime-Bridge-Secret': env.REALTIME_BRIDGE_SECRET },
    body: JSON.stringify({ path: '/internal/oauth-decrypt', input: { oauthCipher: oauthValid ? '' : oauthCipher, sellerCipher: sellerValid ? '' : sellerCipher } })
  });
  const payload = await response.json<any>().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `OAuth migration HTTP ${response.status}`);
  if (payload?.data?.oauthTokens) await putSetting(env, 'oauth_tokens', await encryptTokens(env, payload.data.oauthTokens));
  if (payload?.data?.sellerTokens) await putSetting(env, 'seller_oauth_tokens', await encryptJson(env, payload.data.sellerTokens));
}

type RuntimeSecrets = Partial<Pick<Env,
  'TIKTOK_SHOP_APP_SECRET'|'TIKTOK_SHOP_SERVICE_ID'|'FB_ACCESS_TOKEN'|'TIKTOK_ADS_ACCESS_TOKEN'|
  'ZALO_BOT_TOKEN'|'ZALO_GROUP_CHAT_ID'|'ZALO_WEBHOOK_SECRET'|'ZALO_OPERATIONS_BOT_TOKEN'|
  'ZALO_OPERATIONS_GROUP_CHAT_ID'|'ZALO_OPERATIONS_WEBHOOK_SECRET'|'ZALO_ORDER_BOT_TOKEN'|'ZALO_ORDER_GROUP_CHAT_ID'>>;

async function runtimeSecrets(env: Env): Promise<RuntimeSecrets> {
  const key = 'runtime_provider_secrets';
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  if (row?.value) {
    try { return await decryptJson<RuntimeSecrets>(env, row.value); } catch { /* migrate again below */ }
  }
  if (!env.REALTIME_SOURCE_URL || !env.REALTIME_BRIDGE_SECRET) return {};
  const response = await fetch(`${env.REALTIME_SOURCE_URL.replace(/\/$/, '')}/internal/realtime`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Realtime-Bridge-Secret': env.REALTIME_BRIDGE_SECRET },
    body: JSON.stringify({ path: '/internal/provider-secrets', input: {} })
  });
  const payload = await response.json<any>().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Provider secret migration HTTP ${response.status}`);
  const secrets = (payload?.data || {}) as RuntimeSecrets;
  await putSetting(env, key, await encryptJson(env, secrets));
  return secrets;
}

/** Build an execution environment backed by the new D1, with provider
 * credentials migrated once and encrypted in that D1. */
export async function runtimeProviderEnv(env: Env): Promise<Env> {
  await ensureRuntimeCredentials(env);
  const secrets = await runtimeSecrets(env);
  let sellerTokens: SellerTokenSet | undefined;
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key='seller_oauth_tokens'").first<{ value: string }>();
    if (row?.value) sellerTokens = await decryptJson<SellerTokenSet>(env, row.value);
  } catch { /* Seller routes report the missing grant clearly */ }
  return Object.assign({}, env, secrets, sellerTokens ? { __SELLER_TOKENS: sellerTokens } : {}) as Env;
}

async function tiktokRows(env: Env, input: any): Promise<any[]> {
  // A previous migration stored the shop id with an extra "241" segment
  // (7496309672412416866), while the live TikTok shop id is
  // 749630967241416866. Read both forms so historical snapshots remain
  // visible after the configuration correction.
  const stores = storeIdAliases(input.storeId);
  const placeholders = stores.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT report_date,MAX(cost) AS cost,MAX(gross_revenue) AS gross_revenue,
      MAX(cost_per_order) AS cost_per_order,MAX(sku_orders) AS sku_orders,MAX(aov) AS aov,
      MAX(impressions) AS impressions,MAX(clicks) AS clicks,MAX(ctr) AS ctr,MAX(cr) AS cr
    FROM tiktok_ads_daily WHERE advertiser_id=? AND store_id IN (${placeholders}) AND report_date BETWEEN ? AND ?
    GROUP BY report_date ORDER BY report_date`)
    .bind(String(input.advertiserId), ...stores, input.startDate, input.endDate).all<any>();
  return result.results || [];
}
async function sourceRows(env: Env, input: any): Promise<any[]> {
  const stores = storeIdAliases(input.storeId);
  const placeholders = stores.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json
    FROM tiktok_ads_source_daily WHERE advertiser_id=? AND (store_id IN (${placeholders}) OR store_id LIKE 'ROW_%') AND report_date BETWEEN ? AND ? ORDER BY report_date,source,product_id`)
    .bind(String(input.advertiserId), ...stores, input.startDate, input.endDate).all<any>();
  return result.results || [];
}

function storeIdAliases(value: unknown): string[] {
  const id = String(value || '').trim();
  const aliases = new Set<string>(id ? [id] : []);
  if (id === '749630967241416866') aliases.add('7496309672412416866');
  if (id === '7496309672412416866') aliases.add('749630967241416866');
  return [...aliases];
}
async function facebookRows(env: Env, input: any): Promise<any[]> {
  const result = await env.DB.prepare(`SELECT report_date,spend,gross_revenue,orders,impressions,clicks,ctr,cpm,cpc,messages,landing_page_views
    FROM facebook_ads_daily WHERE report_date BETWEEN ? AND ? ORDER BY report_date`).bind(input.startDate, input.endDate).all<any>();
  return result.results || [];
}

/** Seller tab fallback backed by the replica D1. The legacy Seller API is
 * still used for OAuth mutations, but a dashboard read must not consume the
 * old account's D1 quota when that API is unavailable. */
async function sellerRevenueReplica(env: Env, input: any): Promise<any> {
  const dailyRows = await tiktokRows(env, input);
  const daily = days(input.startDate, input.endDate).map((date) => {
    const row = dailyRows.find((item) => String(item.report_date) === date);
    const orders = numberValue(row?.sku_orders), grossRevenue = numberValue(row?.gross_revenue), cost = numberValue(row?.cost);
    return { date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, metrics: { orders, grossRevenue, cost, aov: orders ? grossRevenue / orders : null } };
  });
  const totals = daily.reduce((out: any, point: any) => {
    out.orders += point.metrics.orders; out.grossRevenue += point.metrics.grossRevenue; out.cost += point.metrics.cost; return out;
  }, { orders: 0, grossRevenue: 0, cost: 0 });
  totals.aov = totals.orders ? totals.grossRevenue / totals.orders : null;
  const rows = await sourceRows(env, input);
  const products = [...new Map(rows.map((row) => [String(row.product_id), row])).values()].map((row) => ({
    id: String(row.product_id), name: String(row.title || row.product_id), gmv: numberValue(row.gross_revenue), orders: numberValue(row.sku_orders), cost: numberValue(row.cost)
  }));
  return {
    startDate: input.startDate, endDate: input.endDate,
    chartStartDate: input.startDate, previousStartDate: shiftDate(input.startDate, -1),
    previousEndDate: shiftDate(input.startDate, -1), generatedAt: new Date().toISOString(),
    source: 'D1_REPLICA', shop: { name: 'TikTok Shop', code: env.DEFAULT_STORE_CODE },
    totals, previousTotals: { orders: 0, grossRevenue: 0, cost: 0, aov: null }, daily,
    provinces: [], gmvAttribution: { products }, previousGmvAttribution: { products: [] },
    analyticsAvailable: true, latestAvailableDate: input.endDate,
    dataQuality: { ready: true, current: { ready: true }, previous: { ready: false } }
  };
}

/** Read-only state served from the new account's D1. OAuth mutations and
 * Supabase backup remain on the legacy Worker. */
async function runtimeState(env: Env): Promise<Response> {
  let adsConnected = false;
  let sellerConnected = false;
  let advertisers: any[] = [];
  try {
    const runtime = await runtimeProviderEnv(env);
    adsConnected = Boolean(await readTokens(runtime));
    sellerConnected = Boolean((await sellerOAuthState(runtime)).connected);
    const rows = await env.DB.prepare('SELECT DISTINCT advertiser_id FROM tiktok_ads_daily ORDER BY advertiser_id').all<any>();
    advertisers = (rows.results || []).filter((row: any) => row.advertiser_id).map((row: any) => ({ advertiserId: String(row.advertiser_id), advertiserName: `Advertiser ${row.advertiser_id}` }));
  } catch { /* configured defaults below keep the shell usable during quota errors */ }
  if (!advertisers.length && env.DEFAULT_ADVERTISER_ID) advertisers = [{ advertiserId: env.DEFAULT_ADVERTISER_ID, advertiserName: `Advertiser ${env.DEFAULT_ADVERTISER_ID}` }];
  const today = dateInTimezone(new Date(), env.TIMEZONE || 'Asia/Bangkok');
  return json({ ok: true, data: {
    connected: adsConnected,
    // Realtime mode always opens on today. If today's snapshot has not landed
    // yet, zero is intentional and the next scheduled refresh fills it.
    startDate: today,
    endDate: today,
    adsOAuth: { status: adsConnected ? 'connected' : 'disconnected', connected: adsConnected, scope: 'mcp:tt4b' },
    sellerOAuth: { configured: sellerConnected, canAuthorize: false, connected: sellerConnected, expiresAt: null, refreshExpiresAt: null, sellerName: '', grantedScopes: [], storage: 'Encrypted D1' },
    dashboardRole: 'admin', defaultAdvertiserId: env.DEFAULT_ADVERTISER_ID,
    defaultStoreCode: env.DEFAULT_STORE_CODE, advertisers
  } });
}

function genericReplicaAnalysis(path: string, input: any, report: any): any {
  const totals = report.totals || { cost: 0, orders: 0, grossRevenue: 0, traffic: 0 };
  if (path === '/api/cads-report') return { advertiserId: input.advertiserId, startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), totals: { spend: numberValue(totals.cost), impressions: numberValue(totals.impressions), watched100: numberValue(totals.orders), clicks: numberValue(totals.traffic), cpm: 0 }, timeSeries: { granularity: 'day', points: (report.daily || []).map((p: any) => ({ key: p.date, label: p.label, metrics: { spend: numberValue(p.metrics?.cost), impressions: numberValue(p.metrics?.impressions), clicks: numberValue(p.metrics?.traffic) } })) }, channels: [], inventory: [], videos: [], diagnostics: {} };
  if (path === '/api/comparison') return { comparisonDate: shiftDate(input.startDate, -1), comparisonStartDate: shiftDate(input.startDate, -1), comparisonEndDate: shiftDate(input.startDate, -1), throughHour: 24, metrics: totals, availableProducts: report.availableProductCount || 0, totalCreatives: report.availableProductCount || 0, impressions: numberValue(totals.impressions), traffic: numberValue(totals.traffic), costAttribution: { total: numberValue(totals.cost), productCard: 0, seller: 0, affiliate: 0, metrics: {} }, summaryComparisonPeriod: 'previous_day', impressionsComparisonPeriod: 'previous_day' };
  if (path === '/api/product-videos') return { campaignId: String(input.campaignId || 'snapshot'), campaignName: 'TikTok Ads', itemGroupId: String(input.itemGroupId || ''), videos: [] };
  if (path === '/api/video-stats') return { itemId: String(input.itemId || ''), startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), source: 'D1_REPLICA', contexts: [], daily: [], video: { itemId: String(input.itemId || ''), cost: 0, orders: 0, grossRevenue: 0 } };
  if (path === '/api/video-metadata') return { itemId: String(input.itemId || ''), video: null };
  if (path === '/api/product-analysis') return { startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), current: { total: totals, products: [] }, previous: { total: {}, products: [] }, daily: [], chartMode: 'SELECTED_RANGE', warnings: ['Dữ liệu sản phẩm chi tiết chưa có trong bản sao D1.'] };
  if (path === '/api/finance-analysis') return { schemaVersion: 'finance-replica', generatedAt: new Date().toISOString(), startDate: input.startDate, endDate: input.endDate, previousStartDate: shiftDate(input.startDate, -1), previousEndDate: shiftDate(input.startDate, -1), shop: { name: 'TikTok Shop', code: envSafeStore(input) }, warnings: ['Đang hiển thị số liệu quảng cáo từ D1 replica.'], previousWarnings: [], current: { summary: totals }, previous: { summary: {} }, todaySettlementNotice: false };
  if (path === '/api/operations-analysis') return { startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), totals, previous: {}, daily: [], orders: [], cancellations: [], warnings: ['Dữ liệu vận hành chi tiết chưa có trong bản sao D1.'] };
  if (path === '/api/koc-analysis') return { startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), totals, creators: [], videos: [], daily: [], warnings: ['Dữ liệu KOC chi tiết chưa có trong bản sao D1.'] };
  if (path === '/api/content-koc-analysis') return { startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), totals, daily: [], creators: [], videos: [], warnings: ['Dữ liệu Content/KOC chi tiết chưa có trong bản sao D1.'] };
  return { startDate: input.startDate, endDate: input.endDate, generatedAt: new Date().toISOString(), totals, daily: [], warnings: ['Dữ liệu chi tiết chưa có trong bản sao D1.'] };
}

function envSafeStore(input: any): string { return String(input?.storeId || 'VNLC33LWAS'); }

export async function readReplica(env: Env, path: string, input: any): Promise<any> {
  const normalized = { advertiserId: String(input?.advertiserId || env.DEFAULT_ADVERTISER_ID), storeId: String(input?.storeId || env.ZALO_STORE_ID || env.DEFAULT_STORE_CODE),
    startDate: String(input?.startDate || input?.endDate), endDate: String(input?.endDate || input?.startDate) };
  if (!normalized.startDate || !normalized.endDate || normalized.startDate > normalized.endDate) throw new Error('Invalid realtime date range.');
  if (path === '/api/report') {
    const rows = await tiktokRows(env, normalized); const byDate = new Map(rows.map((row) => [String(row.report_date), row]));
    const total = emptyTikTok(); const daily = days(normalized.startDate, normalized.endDate).map((date) => {
      const row = byDate.get(date); const metrics = emptyTikTok(); if (row) addTikTok(metrics, row); Object.assign(metrics, { impressions: numberValue(row?.impressions), ctr: numberValue(row?.ctr), cr: numberValue(row?.cr), aov: row?.aov == null ? null : numberValue(row.aov) });
      addTikTok(total, row || {}); return { date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, metrics };
    });
    const sources = await sourceRows(env, normalized); const products = [...new Map(sources.map((row) => [String(row.product_id), row])).values()].map((row) => ({
      campaignId: 'snapshot', campaignName: 'TikTok Ads', campaignActive: true, itemGroupId: String(row.product_id), productName: String(row.title || row.product_id), productImageUrl: '', status: 'AVAILABLE', displayStatus: 'AVAILABLE', optimizationMode: 'Max delivery', targetRoi: null,
      metrics: { cost: numberValue(row.cost), orders: numberValue(row.sku_orders), grossRevenue: numberValue(row.gross_revenue), traffic: numberValue(row.clicks), trafficAvailable: true, costPerOrder: numberValue(row.sku_orders) ? numberValue(row.cost) / numberValue(row.sku_orders) : null, roi: numberValue(row.cost) ? numberValue(row.gross_revenue) / numberValue(row.cost) : null }
    }));
    return { advertiserId: normalized.advertiserId, store: { storeId: normalized.storeId }, startDate: normalized.startDate, endDate: normalized.endDate, generatedAt: new Date().toISOString(), totals: total, products, availableProductCount: products.length, creativeContexts: products.map((p) => ({ campaignId: p.campaignId, itemGroupId: p.itemGroupId })), hourly: [], hourlyMode: 'snapshots', daily, source: 'd1-realtime-bridge' };
  }
  if (path === '/api/ads-traffic-timeline') {
    const rows = await tiktokRows(env, normalized); const byDate = new Map(rows.map((row) => [String(row.report_date), row]));
    return { generatedAt: new Date().toISOString(), source: 'd1-realtime-bridge', granularity: 'day', chartStartDate: normalized.startDate,
      points: days(normalized.startDate, normalized.endDate).map((date) => { const row = byDate.get(date); return { key: date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, metrics: { impressions: numberValue(row?.impressions), clicks: numberValue(row?.clicks), traffic: numberValue(row?.clicks) } }; }) };
  }
  if (path === '/api/creative-summaries') {
    const rows = await sourceRows(env, normalized); const metrics = { productCard: { cost: 0, grossRevenue: 0, impressions: 0, clicks: 0, orders: 0 }, seller: { cost: 0, grossRevenue: 0, impressions: 0, clicks: 0, orders: 0 }, affiliate: { cost: 0, grossRevenue: 0, impressions: 0, clicks: 0, orders: 0 } } as any;
    const sourceRowsOut = rows.map((row) => { const source = String(row.source) === 'productCard' ? 'productCard' : String(row.source) === 'seller' ? 'seller' : 'affiliate'; const m = metrics[source]; m.cost += numberValue(row.cost); m.grossRevenue += numberValue(row.gross_revenue); m.impressions += numberValue(row.impressions); m.clicks += numberValue(row.clicks); m.orders += numberValue(row.sku_orders); return { source, productId: String(row.product_id), date: String(row.report_date), title: String(row.title || ''), metrics: { cost: numberValue(row.cost), gross_revenue: numberValue(row.gross_revenue), orders: numberValue(row.sku_orders), product_impressions: numberValue(row.impressions), product_clicks: numberValue(row.clicks) } }; });
    Object.values<any>(metrics).forEach((m) => { m.roi = m.cost ? m.grossRevenue / m.cost : 0; });
    return { generatedAt: new Date().toISOString(), summaries: [], totalCreatives: new Set(sourceRowsOut.map((r) => r.productId)).size, impressions: sourceRowsOut.reduce((n, r) => n + numberValue(r.metrics.product_impressions), 0), traffic: sourceRowsOut.reduce((n, r) => n + numberValue(r.metrics.product_clicks), 0), costAttribution: { total: Object.values<any>(metrics).reduce((n, m) => n + m.cost, 0), productCard: metrics.productCard.cost, seller: metrics.seller.cost, affiliate: metrics.affiliate.cost, metrics }, sourceRows: sourceRowsOut, videoEvaluation: {}, hourlyTraffic: [], cacheStatus: 'BRIDGE' };
  }
  if (path === '/api/facebook-ads') {
    const rows = await facebookRows(env, normalized); const daily = days(normalized.startDate, normalized.endDate).map((date) => { const row = rows.find((r) => String(r.report_date) === date); const spend = numberValue(row?.spend), impressions = numberValue(row?.impressions), clicks = numberValue(row?.clicks), orders = numberValue(row?.orders), revenue = numberValue(row?.gross_revenue); return { date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, metrics: { spend, impressions, reach: 0, clicks, postEngagement: 0, messages: numberValue(row?.messages), orders, revenue, landingPageViews: numberValue(row?.landing_page_views), cpm: impressions ? spend * 1000 / impressions : 0, cpc: clicks ? spend / clicks : 0, ctr: impressions ? clicks / impressions : 0, cpo: orders ? spend / orders : null, roas: spend ? revenue / spend : null } }; });
    const totals = daily.reduce((acc: any, day: any) => { Object.keys(acc).forEach((key) => { if (typeof acc[key] === 'number') acc[key] += numberValue(day.metrics[key]); }); return acc; }, { spend: 0, impressions: 0, reach: 0, clicks: 0, postEngagement: 0, messages: 0, orders: 0, revenue: 0, landingPageViews: 0, cpm: 0, cpc: 0, ctr: 0, cpo: null, roas: null } as any); totals.cpm = totals.impressions ? totals.spend * 1000 / totals.impressions : 0; totals.cpc = totals.clicks ? totals.spend / totals.clicks : 0; totals.ctr = totals.impressions ? totals.clicks / totals.impressions : 0; totals.cpo = totals.orders ? totals.spend / totals.orders : null; totals.roas = totals.spend ? totals.revenue / totals.spend : null;
    return { totals, daily, campaigns: [], resultCosts: [], previousTotals: totals, startDate: normalized.startDate, endDate: normalized.endDate, chartStartDate: normalized.startDate, generatedAt: new Date().toISOString() };
  }
  if (path === '/api/revenue-analysis') return sellerRevenueReplica(env, normalized);
  if (path === '/api/ads-overview') {
    const [tt, fb] = await Promise.all([readReplica(env, '/api/report', normalized), readReplica(env, '/api/facebook-ads', normalized)]); const t = tt.totals; const f = fb.totals;
    const platform = (cost: number, revenue: number, impressions: number, clicks: number, orders: number) => ({ cost, revenue, impressions, clicks, orders, ctr: impressions ? clicks / impressions : 0, cr: clicks ? orders / clicks : 0, cpc: clicks ? cost / clicks : 0, cpm: impressions ? cost * 1000 / impressions : 0, cpo: orders ? cost / orders : null, roas: cost ? revenue / cost : null });
    return { startDate: normalized.startDate, endDate: normalized.endDate, chartStartDate: normalized.startDate, generatedAt: new Date().toISOString(), totals: platform(f.spend + t.cost, f.revenue + t.grossRevenue, f.impressions + t.impressions, f.clicks + t.traffic, f.orders + t.orders), previousTotals: platform(0, 0, 0, 0, 0), platforms: { facebook: platform(f.spend, f.revenue, f.impressions, f.clicks, f.orders), tiktok: platform(t.cost, t.grossRevenue, t.impressions, t.traffic, t.orders) }, daily: tt.daily.map((day: any) => ({ date: day.date, endDate: day.date, label: day.label, facebook: { cost: 0, clicks: 0, orders: 0 }, tiktok: { cost: day.metrics.cost, clicks: day.metrics.traffic, orders: day.metrics.orders } })), tiktokCostSources: { total: t.cost, productCard: 0, seller: 0, affiliate: 0, unclassified: t.cost }, tiktokDiagnostics: { currentRows: tt.daily.length, previousRows: 0, dailyQueries: 1 }, facebookResultCosts: [] };
  }
  if (['/api/cads-report','/api/comparison','/api/product-videos','/api/video-stats','/api/video-metadata','/api/product-analysis','/api/finance-analysis','/api/operations-analysis','/api/koc-analysis','/api/content-koc-analysis'].includes(path)) {
    const report = await readReplica(env, '/api/report', normalized);
    return genericReplicaAnalysis(path, normalized, report);
  }
  throw new Error(`Realtime bridge does not support ${path}.`);
}

export async function bridgeRequest(request: Request, env: Env): Promise<Response> {
  const supplied = request.headers.get('X-Realtime-Bridge-Secret') || '';
  if (!env.REALTIME_BRIDGE_SECRET || supplied !== env.REALTIME_BRIDGE_SECRET) return json({ ok: false, error: 'Unauthorized realtime bridge.' }, 401);
  const body = await request.json<any>();
  try {
    const path = String(body?.path || ''), input = body?.input || {};
    if (path === '/internal/supabase-chart-history') {
      const startDate = validateDate(input?.startDate, 'startDate');
      const endDate = validateDate(input?.endDate, 'endDate');
      return json({ ok: true, data: await readSupabaseChartHistory(env, {
        advertiserId: String(input?.advertiserId || env.DEFAULT_ADVERTISER_ID),
        storeId: String(input?.storeId || env.ZALO_STORE_ID || env.DEFAULT_STORE_CODE), startDate, endDate
      }) });
    }
    if (path === '/internal/oauth-decrypt') {
      const data: any = {};
      if (input?.oauthCipher) data.oauthTokens = await decryptTokens(env, String(input.oauthCipher));
      if (input?.sellerCipher) data.sellerTokens = await decryptJson<SellerTokenSet>(env, String(input.sellerCipher));
      return json({ ok: true, data });
    }
    if (path === '/internal/provider-secrets') {
      const names: (keyof RuntimeSecrets)[] = ['TIKTOK_SHOP_APP_SECRET','TIKTOK_SHOP_SERVICE_ID','FB_ACCESS_TOKEN','TIKTOK_ADS_ACCESS_TOKEN',
        'ZALO_BOT_TOKEN','ZALO_GROUP_CHAT_ID','ZALO_WEBHOOK_SECRET','ZALO_OPERATIONS_BOT_TOKEN','ZALO_OPERATIONS_GROUP_CHAT_ID',
        'ZALO_OPERATIONS_WEBHOOK_SECRET','ZALO_ORDER_BOT_TOKEN','ZALO_ORDER_GROUP_CHAT_ID'];
      const data: RuntimeSecrets = {};
      for (const name of names) if (env[name]) (data as any)[name] = env[name];
      return json({ ok: true, data });
    }
    if (path === '/api/state') {
      let tokens: any = null; let advertisers: any[] = []; let connectionError: string | undefined;
      // D1 free-tier exhaustion must not blank the dashboard. Keep the
      // configured account visible while the quota resets; report calls will
      // surface the quota error separately if they are attempted meanwhile.
      try { tokens = await readTokens(env); } catch (error) { connectionError = error instanceof Error ? error.message : String(error); }
      if (tokens) { try { advertisers = await listAdvertisers(env, await createSession(env)); } catch (error) { connectionError = error instanceof Error ? error.message : String(error); } }
      // Some valid MCP grants return an empty auth_advertiser_get listing.
      // The legacy account already has a configured, authorized advertiser ID;
      // expose it so the dashboard can load the same account as the Sheet.
      if (!advertisers.length && env.DEFAULT_ADVERTISER_ID) advertisers = [{ advertiserId: env.DEFAULT_ADVERTISER_ID, advertiserName: `Advertiser ${env.DEFAULT_ADVERTISER_ID}` }];
      const today = dateInTimezone(new Date(), env.TIMEZONE || 'Asia/Bangkok');
      let sellerOAuth: any;
      try { sellerOAuth = await sellerOAuthState(env); } catch (error) {
        if (!connectionError) connectionError = error instanceof Error ? error.message : String(error);
        sellerOAuth = { configured: Boolean(env.TIKTOK_SHOP_APP_KEY && env.TIKTOK_SHOP_APP_SECRET), canAuthorize: Boolean(env.TIKTOK_SHOP_SERVICE_ID), connected: false, expiresAt: null, refreshExpiresAt: null, sellerName: '', grantedScopes: [], storage: 'Encrypted D1' };
      }
      const quotaFallback = /free tier daily row read limit/i.test(connectionError || '');
      const adsOAuth = tokens ? oauthConnectionState(tokens, env.MCP_SCOPE) : quotaFallback ? { status: 'connected', connected: true, scope: env.MCP_SCOPE } : oauthConnectionState(tokens, env.MCP_SCOPE);
      return json({ ok: true, data: { connected: Boolean(tokens) || quotaFallback, startDate: today, endDate: today, adsOAuth, sellerOAuth, dashboardRole: 'admin', defaultAdvertiserId: env.DEFAULT_ADVERTISER_ID, defaultStoreCode: env.DEFAULT_STORE_CODE, advertisers, connectionError } });
    }
    if (path === '/api/stores') {
      const advertiserId = String(input?.advertiserId || input || env.DEFAULT_ADVERTISER_ID);
      let stores: any[] = [];
      try { stores = await listStores(env, await createSession(env), advertiserId); } catch { /* use configured Shop ID below */ }
      if (!stores.length && env.ZALO_STORE_ID) stores = [{ storeId: env.ZALO_STORE_ID, storeName: 'TikTok Shop', storeCode: env.DEFAULT_STORE_CODE }];
      return json({ ok: true, data: stores });
    }
    if (path === '/api/revenue-analysis') {
      const startDate = validateDate(input?.startDate, 'startDate');
      const endDate = validateDate(input?.endDate, 'endDate');
      if (startDate > endDate) return json({ ok: false, error: 'Khoảng ngày không hợp lệ.' }, 400);
      // Seller revenue is not part of the replica tables. Execute the same
      // legacy Seller API flow on the old Worker, where the encrypted Seller
      // grant and app credentials are available.
      const data = await loadSellerRevenueAnalysis(env, {
        startDate,
        endDate,
        forceRefresh: input?.forceRefresh === true,
      });
      return json({ ok: true, data });
    }
    if (path === '/api/oauth/connect') return json({ ok: true, data: await createAuthorizationUrl(env, String(input?.origin || env.PUBLIC_BASE_URL)) });
    if (path === '/api/oauth/refresh') return json({ ok: true, data: await refreshAccessToken(env) });
    if (path === '/api/oauth/disconnect') { await disconnect(env); return json({ ok: true, data: true }); }
    if (path === '/api/seller/disconnect') { await disconnectSeller(env); return json({ ok: true, data: true }); }
    if (path === '/api/admin/verify') return json({ ok: true, data: String(input?.password || input || '') === String(env.ADMIN_PASSWORD || '') });
    if (path === '/api/admin/supabase-sync') {
      if (String(input?.method || 'GET') === 'GET') {
        const row = await env.DB.prepare("SELECT value,updated_at FROM app_settings WHERE key='SUPABASE_MANUAL_SYNC_STATUS'").first<any>();
        return json({ ok: true, data: { ...(row?.value ? JSON.parse(row.value) : { status: 'IDLE', progress: 0 }), updatedAt: row?.updated_at || null } });
      }
      const startDate = validateDate(input?.startDate, 'startDate'), endDate = validateDate(input?.endDate, 'endDate');
      if (startDate > endDate) return json({ ok: false, error: 'Khoảng ngày không hợp lệ.' }, 400);
      const tables = Array.isArray(input?.tables) ? input.tables.map(String) : ['all'];
      await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
        .bind(JSON.stringify({ status: 'QUEUED', startDate, endDate, progress: 0, tables })).run();
      await env.TASK_QUEUE.send({ type: 'supabase-manual-sync', startDate, endDate, tables });
      return json({ ok: true, data: { queued: true } });
    }
    return json({ ok: true, data: await readReplica(env, path, input) });
  }
  catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502); }
}

async function supabaseChartHistory(env: Env, input: any, startDate: string, endDate: string): Promise<{ tiktok: any[]; facebook: any[] }> {
  if (startDate > endDate || !env.REALTIME_SOURCE_URL || !env.REALTIME_BRIDGE_SECRET) return { tiktok: [], facebook: [] };
  const cacheKey=new Request(`https://runtime-history-cache.internal/${encodeURIComponent(String(input.advertiserId||''))}/${encodeURIComponent(String(input.storeId||''))}/${startDate}/${endDate}`);
  const edgeCache=typeof caches!=='undefined'?await caches.open('runtime-supabase-history-v1'):null;
  const cached=edgeCache?await edgeCache.match(cacheKey):null;if(cached)return cached.json<{tiktok:any[];facebook:any[]}>();
  const response = await fetch(`${env.REALTIME_SOURCE_URL.replace(/\/$/, '')}/internal/realtime`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Realtime-Bridge-Secret': env.REALTIME_BRIDGE_SECRET },
    body: JSON.stringify({ path: '/internal/supabase-chart-history', input: { ...input, startDate, endDate } })
  });
  const payload = await response.json<any>().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Supabase history bridge HTTP ${response.status}`);
  const result={ tiktok: payload?.data?.tiktok || [], facebook: payload?.data?.facebook || [] };
  if(edgeCache)await edgeCache.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=900'}}));
  return result;
}

function tiktokHistoryPoint(date: string, row?: any): any {
  const cost=numberValue(row?.cost),orders=numberValue(row?.sku_orders),grossRevenue=numberValue(row?.gross_revenue),traffic=numberValue(row?.clicks);
  return { date, label: `${date.slice(8,10)}/${date.slice(5,7)}`, metrics: { cost, orders, grossRevenue, traffic,
    impressions:numberValue(row?.impressions),trafficAvailable:true,costPerOrder:orders?cost/orders:null,roi:cost?grossRevenue/cost:null,
    ctr:numberValue(row?.ctr),cr:numberValue(row?.cr),aov:row?.aov==null?(orders?grossRevenue/orders:null):numberValue(row.aov) } };
}

function mergeTikTokChart(startDate: string, endDate: string, history: any[], live: any[]): any[] {
  const historyByDate=new Map(history.map((row:any)=>[String(row.report_date),row]));
  const liveByDate=new Map((live||[]).map((point:any)=>[String(point.date||point.key),point]));
  return days(startDate,endDate).map((date)=>liveByDate.get(date)||tiktokHistoryPoint(date,historyByDate.get(date)));
}

function overviewPlatform(cost:number,revenue:number,impressions:number,clicks:number,orders:number):any {
  return {cost,revenue,impressions,clicks,orders,ctr:impressions?clicks/impressions:0,cr:clicks?orders/clicks:0,
    cpc:clicks?cost/clicks:0,cpm:impressions?cost*1000/impressions:0,cpo:orders?cost/orders:null,roas:cost?revenue/cost:null};
}

export async function gatewayRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const gatewayOrigin = request.headers.get('X-Realtime-Gateway-Origin') || url.origin;
  if (url.pathname === '/auth/connect' && request.method === 'GET') return Response.redirect(await createAuthorizationUrl(env, gatewayOrigin), 302);
  if (url.pathname === '/auth/callback' && request.method === 'GET')
    return url.searchParams.has('app_key') ? handleSellerOAuthCallback(await runtimeProviderEnv(env), url) : handleOAuthCallback(env, url);
  if (url.pathname === '/oauth/callback' && request.method === 'GET') return handleOAuthCallback(env, url);
  if (url.pathname === '/seller/auth/connect' && request.method === 'GET')
    return Response.redirect(await createSellerAuthorizationUrl(await runtimeProviderEnv(env)), 302);
  if (url.pathname === '/seller/auth/callback' && request.method === 'GET') return handleSellerOAuthCallback(await runtimeProviderEnv(env), url);
  if (url.pathname === '/internal/runtime-sync' && request.method === 'POST') {
    const supplied = request.headers.get('X-Realtime-Bridge-Secret') || '';
    if (!env.REALTIME_BRIDGE_SECRET || supplied !== env.REALTIME_BRIDGE_SECRET) return json({ ok: false, error: 'Unauthorized realtime sync.' }, 401);
    try {
      const body = await request.json<any>();
      if (body?.kind === 'tiktok') await saveTikTokAdsSnapshot(env, body.input || {}, body.report || {});
      else if (body?.kind === 'facebook') await saveFacebookAdsSnapshot(env, String(body.input?.advertiserId || ''), body.report || {});
      else return json({ ok: false, error: 'Invalid realtime sync kind.' }, 400);
      return json({ ok: true });
    } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502); }
  }
  if (url.pathname === '/internal/zalo-send' && request.method === 'POST') {
    const supplied = request.headers.get('X-Realtime-Bridge-Secret') || '';
    if (!env.REALTIME_BRIDGE_SECRET || supplied !== env.REALTIME_BRIDGE_SECRET) return json({ ok: false, error: 'Unauthorized realtime bridge.' }, 401);
    const body = await request.json<any>(); const token = String(body?.token || ''), method = String(body?.method || '');
    if (!token || !/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(method)) return json({ ok: false, error: 'Invalid Zalo bridge request.' }, 400);
    let claimed = false;
    if (body?.dedupeKey && body?.reportDate && Number.isFinite(Number(body?.reportHour)) && env.DB) {
      try {
        const claim = await env.DB.prepare(`INSERT INTO scheduled_reports(report_date,report_hour,status,payload)
          VALUES(?,?,'SENDING',?) ON CONFLICT(report_date,report_hour) DO UPDATE SET status='SENDING',payload=excluded.payload,updated_at=CURRENT_TIMESTAMP
          WHERE scheduled_reports.status<>'SENT' AND (scheduled_reports.status<>'SENDING' OR scheduled_reports.updated_at<datetime('now','-10 minutes'))`)
          .bind(String(body.reportDate), Number(body.reportHour), JSON.stringify({ dedupeKey: String(body.dedupeKey) })).run();
        if (!claim.meta.changes) return json({ ok: true, result: { message_id: '', deduped: true } });
        claimed = true;
      } catch { /* old caller may be running while the replica is unavailable */ }
    }
    const response = await fetch(`https://bot-api.zaloplatforms.com/bot${encodeURIComponent(token)}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body?.payload || {}) });
    const text = await response.text();
    if (claimed && env.DB) { try { const result = JSON.parse(text); await env.DB.prepare(`UPDATE scheduled_reports SET status=?,message_id=?,payload=?,updated_at=CURRENT_TIMESTAMP WHERE report_date=? AND report_hour=?`).bind(response.ok && result?.ok === true ? 'SENT' : 'FAILED', String(result?.result?.message_id || ''), text.slice(0, 4000), String(body.reportDate), Number(body.reportHour)).run(); } catch { /* delivery response remains authoritative */ } }
    return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.pathname === '/api/state' && request.method === 'GET' && env.DB) return runtimeState(env);
  if (url.pathname === '/api/stores' && request.method === 'POST' && env.DB)
    return json({ ok: true, data: [{ storeId: env.ZALO_STORE_ID || env.DEFAULT_STORE_CODE, storeName: 'TikTok Shop', storeCode: env.DEFAULT_STORE_CODE }] });
  const localReadPaths = new Set(['/api/report','/api/ads-traffic-timeline','/api/creative-summaries','/api/facebook-ads','/api/ads-overview','/api/revenue-analysis','/api/cads-report','/api/comparison','/api/product-videos','/api/video-stats','/api/video-metadata','/api/product-analysis','/api/finance-analysis','/api/operations-analysis','/api/koc-analysis','/api/content-koc-analysis']);
  if (request.method === 'POST' && localReadPaths.has(url.pathname) && env.DB) {
    try {
      const input = await request.json<any>();
      const runtime = await runtimeProviderEnv(env);
      const liveInput = {
        ...input,
        advertiserId: String(input?.advertiserId || env.DEFAULT_ADVERTISER_ID),
        storeId: String(input?.storeId || env.ZALO_STORE_ID || env.DEFAULT_STORE_CODE),
        forceRefresh: input?.forceRefresh === true,
      };
      let data: any;
      switch (url.pathname) {
        case '/api/report': {
          const selectedDays=Math.max(1,Math.round((Date.parse(`${liveInput.endDate}T00:00:00Z`)-Date.parse(`${liveInput.startDate}T00:00:00Z`))/86400000)+1);
          const chartStartDate=selectedDays<7?shiftDate(liveInput.endDate,-6):liveInput.startDate;
          const today=dateInTimezone(new Date(),env.TIMEZONE||'Asia/Bangkok'),historyEnd=liveInput.endDate<today?liveInput.endDate:shiftDate(today,-1);
          const hasToday=liveInput.startDate<=today&&liveInput.endDate>=today;
          const [history,live,liveTraffic]=await Promise.all([
            supabaseChartHistory(env,liveInput,chartStartDate,historyEnd).catch(()=>({tiktok:[],facebook:[]})),
            hasToday?loadMainReport(runtime,{...liveInput,startDate:today,endDate:today},liveInput.forceRefresh):Promise.resolve(null),
            hasToday?loadAdsTrafficTimeline(runtime,{...liveInput,startDate:today,endDate:today} as any).catch(()=>null):Promise.resolve(null)
          ]);
          const trafficByDate=new Map((liveTraffic?.points||[]).map((point:any)=>[String(point.key),point.metrics||{}]));
          const liveDaily=(live?.daily||[]).map((point:any)=>{const traffic:any=trafficByDate.get(String(point.date))||{};return {...point,metrics:{...point.metrics,
            impressions:numberValue(traffic.impressions),traffic:numberValue(traffic.clicks??traffic.traffic),trafficAvailable:true}};});
          const chartDaily=mergeTikTokChart(chartStartDate,liveInput.endDate,history.tiktok,liveDaily);
          const selectedDaily=chartDaily.filter((point:any)=>point.date>=liveInput.startDate&&point.date<=liveInput.endDate);
          const totals=selectedDaily.reduce((out:any,point:any)=>{const m=point.metrics||{};out.cost+=numberValue(m.cost);out.orders+=numberValue(m.orders);
            out.grossRevenue+=numberValue(m.grossRevenue);out.traffic+=numberValue(m.traffic);out.trafficAvailable=true;return out;},emptyTikTok());
          totals.costPerOrder=totals.orders?totals.cost/totals.orders:null;totals.roi=totals.cost?totals.grossRevenue/totals.cost:null;
          data={advertiserId:liveInput.advertiserId,store:{storeId:liveInput.storeId},startDate:liveInput.startDate,endDate:liveInput.endDate,
            generatedAt:new Date().toISOString(),totals,products:live?.products||[],availableProductCount:live?.availableProductCount||0,
            creativeContexts:live?.creativeContexts||[],hourly:live?.hourly||[],hourlyMode:live?.hourlyMode||'snapshots',daily:selectedDaily,
            source:'supabase-history+mcp-today',trafficEmbedded:true,chartStartDate,chartDaily};break;
        }
        case '/api/ads-traffic-timeline': {
          const today=dateInTimezone(new Date(),env.TIMEZONE||'Asia/Bangkok');
          const selectedDays=Math.max(1,Math.round((Date.parse(`${liveInput.endDate}T00:00:00Z`)-Date.parse(`${liveInput.startDate}T00:00:00Z`))/86400000)+1);
          const chartStartDate=selectedDays<7?shiftDate(liveInput.endDate,-6):liveInput.startDate,historyEnd=liveInput.endDate<today?liveInput.endDate:shiftDate(today,-1);
          const history=await supabaseChartHistory(env,liveInput,chartStartDate,historyEnd).catch(()=>({tiktok:[],facebook:[]}));
          let livePoints:any[]=[];if(liveInput.endDate>=today){const live=await loadAdsTrafficTimeline(runtime,{...liveInput,startDate:today});livePoints=live.points||[];}
          data={generatedAt:new Date().toISOString(),source:'supabase-history+mcp-today',granularity:'day',chartStartDate,
            points:mergeTikTokChart(chartStartDate,liveInput.endDate,history.tiktok,livePoints).map((point:any)=>({key:point.date,label:point.label,metrics:{impressions:numberValue(point.metrics?.impressions),clicks:numberValue(point.metrics?.traffic),traffic:numberValue(point.metrics?.traffic)}}))};break;
        }
        case '/api/creative-summaries': {
          let creativeInput=liveInput;
          if(!Array.isArray(liveInput.allContexts)||liveInput.allContexts.length===0){
            const report=await loadMainReport(runtime,liveInput,false);
            creativeInput={...liveInput,products:report.products||[],allContexts:report.creativeContexts||[],availableProducts:report.availableProductCount||0};
          }
          data=await loadCreativeSummaries(runtime,creativeInput);break;
        }
        case '/api/facebook-ads': data = await loadFacebookAdsReport(runtime, liveInput); break;
        case '/api/ads-overview': {
          const today=dateInTimezone(new Date(),env.TIMEZONE||'Asia/Bangkok');
          const selectedDays=Math.max(1,Math.round((Date.parse(`${liveInput.endDate}T00:00:00Z`)-Date.parse(`${liveInput.startDate}T00:00:00Z`))/86400000)+1);
          const chartStartDate=selectedDays<7?shiftDate(liveInput.endDate,-6):liveInput.startDate,historyEnd=liveInput.endDate<today?liveInput.endDate:shiftDate(today,-1);
          const hasToday=liveInput.startDate<=today&&liveInput.endDate>=today;
          const [history,liveTikTok,liveTraffic,liveFacebook]=await Promise.all([
            supabaseChartHistory(env,liveInput,chartStartDate,historyEnd).catch(()=>({tiktok:[],facebook:[]})),
            hasToday?loadMainReport(runtime,{...liveInput,startDate:today,endDate:today},liveInput.forceRefresh):Promise.resolve(null),
            hasToday?loadAdsTrafficTimeline(runtime,{...liveInput,startDate:today,endDate:today} as any).catch(()=>null):Promise.resolve(null),
            hasToday?loadFacebookAdsReport(runtime,{...liveInput,startDate:today,endDate:today}):Promise.resolve(null)
          ]);
          const tt=new Map(history.tiktok.map((row:any)=>[String(row.report_date),row])),fb=new Map(history.facebook.map((row:any)=>[String(row.report_date),row]));
          const tm=liveTikTok?.totals||{},fm=liveFacebook?.totals||{},traffic=(liveTraffic?.points||[]).find((point:any)=>String(point.key)===today)?.metrics||{};
          const liveByDate=new Map(hasToday?[[today,{date:today,endDate:today,label:`${today.slice(8,10)}/${today.slice(5,7)}`,
            facebook:{cost:numberValue(fm.spend),clicks:numberValue(fm.clicks),orders:numberValue(fm.orders),revenue:numberValue(fm.revenue),impressions:numberValue(fm.impressions)},
            tiktok:{cost:numberValue(tm.cost),clicks:numberValue(traffic.clicks??traffic.traffic),orders:numberValue(tm.orders),revenue:numberValue(tm.grossRevenue),impressions:numberValue(traffic.impressions)}}]]:[]);
          const daily=days(chartStartDate,liveInput.endDate).map((date)=>{const liveDay:any=liveByDate.get(date);if(liveDay)return liveDay;const tr:any=tt.get(date)||{},fr:any=fb.get(date)||{};
            return {date,endDate:date,label:`${date.slice(8,10)}/${date.slice(5,7)}`,facebook:{cost:numberValue(fr.spend),clicks:numberValue(fr.clicks),orders:numberValue(fr.orders),revenue:numberValue(fr.gross_revenue),impressions:numberValue(fr.impressions)},tiktok:{cost:numberValue(tr.cost),clicks:numberValue(tr.clicks),orders:numberValue(tr.sku_orders),revenue:numberValue(tr.gross_revenue),impressions:numberValue(tr.impressions)}};});
          const selected=daily.filter((day:any)=>day.date>=liveInput.startDate);const sum=(key:'facebook'|'tiktok')=>selected.reduce((out:any,day:any)=>{for(const field of ['cost','revenue','impressions','clicks','orders'])out[field]+=numberValue(day[key]?.[field]);return out;},{cost:0,revenue:0,impressions:0,clicks:0,orders:0});
          const fs=sum('facebook'),ts=sum('tiktok'),facebook=overviewPlatform(fs.cost,fs.revenue,fs.impressions,fs.clicks,fs.orders),tiktok=overviewPlatform(ts.cost,ts.revenue,ts.impressions,ts.clicks,ts.orders);
          data={startDate:liveInput.startDate,endDate:liveInput.endDate,chartStartDate,generatedAt:new Date().toISOString(),daily,
            totals:overviewPlatform(fs.cost+ts.cost,fs.revenue+ts.revenue,fs.impressions+ts.impressions,fs.clicks+ts.clicks,fs.orders+ts.orders),previousTotals:overviewPlatform(0,0,0,0,0),platforms:{facebook,tiktok},
            tiktokCostSources:{total:tiktok.cost,productCard:0,seller:0,affiliate:0,unclassified:tiktok.cost},tiktokDiagnostics:{source:'supabase-history+mcp-today'},facebookResultCosts:liveFacebook?.resultCosts||[],historySource:'supabase-history+mcp-today'};break;
        }
        case '/api/revenue-analysis': data = await loadSellerRevenueAnalysis(runtime, liveInput); break;
        case '/api/cads-report': data = await loadCAdsReport(runtime, liveInput); break;
        case '/api/comparison': data = await loadComparison(runtime, liveInput); break;
        case '/api/product-videos': data = await loadProductVideos(runtime, liveInput); break;
        case '/api/video-stats': data = await loadVideoStats(runtime, liveInput); break;
        case '/api/video-metadata': data = await loadVideoMetadata(runtime, liveInput); break;
        case '/api/product-analysis': data = await loadProductAnalysis(runtime, liveInput); break;
        case '/api/finance-analysis': data = await loadFinanceAnalysis(runtime, liveInput); break;
        case '/api/operations-analysis': data = await loadOperationsAnalysis(runtime, liveInput); break;
        case '/api/koc-analysis': data = await loadKocAnalysis(runtime, liveInput); break;
        case '/api/content-koc-analysis': data = await loadContentKocAnalysis(runtime, liveInput); break;
        default: data = await readReplica(runtime, url.pathname, liveInput);
      }
      return json({ ok: true, data });
    }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502); }
  }
  if (url.pathname === '/api/oauth/connect' && request.method === 'GET') return json({ ok: true, data: await createAuthorizationUrl(env, gatewayOrigin) });
  if (url.pathname === '/api/oauth/refresh' && request.method === 'POST') return json({ ok: true, data: await refreshAccessToken(env) });
  if (url.pathname === '/api/oauth/disconnect' && request.method === 'POST') { await disconnect(env); return json({ ok: true, data: true }); }
  if (url.pathname === '/api/seller/disconnect' && request.method === 'POST') { await disconnectSeller(await runtimeProviderEnv(env)); return json({ ok: true, data: true }); }
  // OAuth, Seller analysis and Supabase administration stay on the legacy
  // bridge because that Worker owns the provider secrets and backup flow.
  const proxiedAuth = new Set(['/auth/login','/auth/logout']);
  if (proxiedAuth.has(url.pathname)) {
    if (!env.REALTIME_SOURCE_URL) return json({ ok: false, error: 'Realtime source is not configured.' }, 503);
    // Rebuild the request body and hop-by-hop headers. Passing the original
    // stream together with its Content-Length/Content-Encoding can make the
    // old Worker reject an otherwise valid login payload after proxying.
    const headers = new Headers(request.headers);
    for (const name of ['host', 'content-length', 'content-encoding', 'connection', 'accept-encoding']) headers.delete(name);
    headers.set('X-Realtime-Gateway-Origin', url.origin);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const source = env.REALTIME_SOURCE_URL.replace(/\/$/, '');
    const upstream = await fetch(`${source}${url.pathname}${url.search}`, { method: request.method, headers, body });
    const outHeaders = new Headers(upstream.headers); const location = outHeaders.get('Location');
    if (location) { try { const target = new URL(location, source); if (target.origin === new URL(source).origin) outHeaders.set('Location', `${url.origin}${target.pathname}${target.search}${target.hash}`); } catch { /* keep provider redirect */ } }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
  }
  const adminBridgePath = url.pathname === '/api/admin/verify' || url.pathname === '/api/admin/supabase-sync' || url.pathname === '/api/oauth/connect';
  if (!url.pathname.startsWith('/api/') || (request.method !== 'POST' && !(adminBridgePath && request.method === 'GET'))) return new Response('');
  if (!env.REALTIME_SOURCE_URL || !env.REALTIME_BRIDGE_SECRET) return json({ ok: false, error: 'Realtime gateway is not configured.' }, 503);
  const input = request.method === 'GET' ? { method: 'GET', origin: request.headers.get('X-Realtime-Gateway-Origin') || url.origin } : await request.json<any>(); const upstream = await fetch(`${env.REALTIME_SOURCE_URL.replace(/\/$/, '')}/internal/realtime`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Realtime-Bridge-Secret': env.REALTIME_BRIDGE_SECRET }, body: JSON.stringify({ path: url.pathname, input }) });
  return new Response(await upstream.text(), { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** Proxy browser API calls from the legacy custom domain to the realtime
 * account while preserving the legacy origin for OAuth redirect URIs. */
export async function realtimeProxyRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.REALTIME_GATEWAY_URL) return json({ ok: false, error: 'Realtime gateway is not configured.' }, 503);
  const headers = new Headers(request.headers);
  for (const name of ['host', 'content-length', 'content-encoding', 'connection', 'accept-encoding']) headers.delete(name);
  headers.set('X-Realtime-Gateway-Origin', url.origin);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const target = `${env.REALTIME_GATEWAY_URL.replace(/\/$/, '')}${url.pathname}${url.search}`;
  return fetch(target, { method: request.method, headers, body });
}
