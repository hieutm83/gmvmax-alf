import type { Env } from './types';
import { json, numberValue, shiftDate, validateDate } from './utils';
import { createAuthorizationUrl, disconnect, oauthConnectionState, readTokens, refreshAccessToken } from './oauth';
import { disconnectSeller } from './seller';
import { sellerOAuthState } from './seller';
import { createSession, listAdvertisers, listStores } from './mcp';
import { dateInTimezone } from './utils';

function emptyTikTok() { return { cost: 0, orders: 0, grossRevenue: 0, traffic: 0, trafficAvailable: true, costPerOrder: null, roi: null }; }
function addTikTok(target: any, row: any): void {
  target.cost += numberValue(row.cost); target.orders += numberValue(row.sku_orders);
  target.grossRevenue += numberValue(row.gross_revenue); target.traffic += numberValue(row.clicks);
  target.costPerOrder = target.orders ? target.cost / target.orders : null;
  target.roi = target.cost ? target.grossRevenue / target.cost : null;
}
function days(start: string, end: string): string[] { const out: string[] = []; for (let d = start; d <= end; d = shiftDate(d, 1)) out.push(d); return out; }

async function tiktokRows(env: Env, input: any): Promise<any[]> {
  const result = await env.DB.prepare(`SELECT report_date,cost,gross_revenue,cost_per_order,sku_orders,aov,impressions,clicks,ctr,cr
    FROM tiktok_ads_daily WHERE advertiser_id=? AND store_id=? AND report_date BETWEEN ? AND ? ORDER BY report_date`)
    .bind(String(input.advertiserId), String(input.storeId), input.startDate, input.endDate).all<any>();
  return result.results || [];
}
async function sourceRows(env: Env, input: any): Promise<any[]> {
  const result = await env.DB.prepare(`SELECT report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json
    FROM tiktok_ads_source_daily WHERE advertiser_id=? AND store_id=? AND report_date BETWEEN ? AND ? ORDER BY report_date,source,product_id`)
    .bind(String(input.advertiserId), String(input.storeId), input.startDate, input.endDate).all<any>();
  return result.results || [];
}
async function facebookRows(env: Env, input: any): Promise<any[]> {
  const result = await env.DB.prepare(`SELECT report_date,spend,gross_revenue,orders,impressions,clicks,ctr,cpm,cpc,messages,landing_page_views
    FROM facebook_ads_daily WHERE report_date BETWEEN ? AND ? ORDER BY report_date`).bind(input.startDate, input.endDate).all<any>();
  return result.results || [];
}

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
  if (path === '/api/ads-overview') {
    const [tt, fb] = await Promise.all([readReplica(env, '/api/report', normalized), readReplica(env, '/api/facebook-ads', normalized)]); const t = tt.totals; const f = fb.totals;
    const platform = (cost: number, revenue: number, impressions: number, clicks: number, orders: number) => ({ cost, revenue, impressions, clicks, orders, ctr: impressions ? clicks / impressions : 0, cr: clicks ? orders / clicks : 0, cpc: clicks ? cost / clicks : 0, cpm: impressions ? cost * 1000 / impressions : 0, cpo: orders ? cost / orders : null, roas: cost ? revenue / cost : null });
    return { startDate: normalized.startDate, endDate: normalized.endDate, chartStartDate: normalized.startDate, generatedAt: new Date().toISOString(), totals: platform(f.spend + t.cost, f.revenue + t.grossRevenue, f.impressions + t.impressions, f.clicks + t.traffic, f.orders + t.orders), previousTotals: platform(0, 0, 0, 0, 0), platforms: { facebook: platform(f.spend, f.revenue, f.impressions, f.clicks, f.orders), tiktok: platform(t.cost, t.grossRevenue, t.impressions, t.traffic, t.orders) }, daily: tt.daily.map((day: any) => ({ date: day.date, endDate: day.date, label: day.label, facebook: { cost: 0, clicks: 0, orders: 0 }, tiktok: { cost: day.metrics.cost, clicks: day.metrics.traffic, orders: day.metrics.orders } })), tiktokCostSources: { total: t.cost, productCard: 0, seller: 0, affiliate: 0, unclassified: t.cost }, tiktokDiagnostics: { currentRows: tt.daily.length, previousRows: 0, dailyQueries: 1 }, facebookResultCosts: [] };
  }
  throw new Error(`Realtime bridge does not support ${path}.`);
}

export async function bridgeRequest(request: Request, env: Env): Promise<Response> {
  const supplied = request.headers.get('X-Realtime-Bridge-Secret') || '';
  if (!env.REALTIME_BRIDGE_SECRET || supplied !== env.REALTIME_BRIDGE_SECRET) return json({ ok: false, error: 'Unauthorized realtime bridge.' }, 401);
  const body = await request.json<any>();
  try {
    const path = String(body?.path || ''), input = body?.input || {};
    if (path === '/api/state') {
      const tokens = await readTokens(env); let advertisers: any[] = []; let connectionError: string | undefined;
      if (tokens) { try { advertisers = await listAdvertisers(env, await createSession(env)); } catch (error) { connectionError = error instanceof Error ? error.message : String(error); } }
      const today = dateInTimezone(new Date(), env.TIMEZONE || 'Asia/Bangkok');
      return json({ ok: true, data: { connected: Boolean(tokens), startDate: today, endDate: today, adsOAuth: oauthConnectionState(tokens, env.MCP_SCOPE), sellerOAuth: await sellerOAuthState(env), dashboardRole: 'admin', defaultAdvertiserId: env.DEFAULT_ADVERTISER_ID, defaultStoreCode: env.DEFAULT_STORE_CODE, advertisers, connectionError } });
    }
    if (path === '/api/stores') return json({ ok: true, data: await listStores(env, await createSession(env), String(input?.advertiserId || input || env.DEFAULT_ADVERTISER_ID)) });
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

export async function gatewayRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/internal/zalo-send' && request.method === 'POST') {
    const supplied = request.headers.get('X-Realtime-Bridge-Secret') || '';
    if (!env.REALTIME_BRIDGE_SECRET || supplied !== env.REALTIME_BRIDGE_SECRET) return json({ ok: false, error: 'Unauthorized realtime bridge.' }, 401);
    const body = await request.json<any>(); const token = String(body?.token || ''), method = String(body?.method || '');
    if (!token || !/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(method)) return json({ ok: false, error: 'Invalid Zalo bridge request.' }, 400);
    const response = await fetch(`https://bot-api.zaloplatforms.com/bot${encodeURIComponent(token)}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body?.payload || {}) });
    const text = await response.text(); return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }
  // State and stores are read from the legacy D1/MCP account through the
  // authenticated bridge, not fabricated in the realtime gateway.
  const proxiedAuth = new Set(['/auth/login','/auth/logout','/auth/connect','/auth/callback','/oauth/callback','/seller/auth/connect','/seller/auth/callback']);
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
  const adminBridgePath = url.pathname === '/api/state' || url.pathname === '/api/stores' || url.pathname === '/api/admin/verify' || url.pathname === '/api/admin/supabase-sync' || url.pathname === '/api/oauth/connect';
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
