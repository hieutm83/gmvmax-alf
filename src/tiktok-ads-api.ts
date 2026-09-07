import type { Env } from './types';
import { getAccessToken } from './oauth';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

type TrafficPoint = { key: string; label: string; metrics: { impressions: number; clicks: number; traffic: number } };

/** Keep short report selections readable without changing their KPI totals. */
export function adsTrafficChartStartDate(startDate: string, endDate: string, minimumDays = 7): string {
  const selectedDays = Math.max(1, Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1);
  return selectedDays <= minimumDays ? shiftDate(endDate, -minimumDays + 1) : startDate;
}

function dailyPoints(startDate: string, endDate: string): TrafficPoint[] {
  const points: TrafficPoint[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) points.push({ key: date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, metrics: { impressions: 0, clicks: 0, traffic: 0 } });
  return points;
}
function responseRows(body: any): any[] { const data = body?.data || {}; return Array.isArray(data.list) ? data.list : Array.isArray(data.data_list) ? data.data_list : Array.isArray(body?.list) ? body.list : []; }
function rowDate(row: any): string { return String(row?.dimensions?.stat_time_day ?? row?.stat_time_day ?? row?.dimension?.stat_time_day ?? '').slice(0, 10); }

/** Direct TikTok Ads API traffic: no MCP calls for display/click KPIs or charts. */
export async function loadTikTokAdsTraffic(env: Env, input: any): Promise<any> {
  const chartStartDate = adsTrafficChartStartDate(input.startDate, input.endDate);
  const cacheKey = stableKey('tiktok-ads-api-traffic-v3', { advertiserId: input.advertiserId, startDate: input.startDate, endDate: input.endDate, chartStartDate });
  if (!input.forceRefresh) { const cached = await cacheGet<any>(env, cacheKey); if (cached) return cached; }
  const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
  // Advertiser/day grain is the authoritative aggregate for these two KPIs.
  // It avoids ad-level pagination and prevents a partial series for accounts
  // with many creatives.
  const params: Record<string, string> = { advertiser_id: String(input.advertiserId), report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER', dimensions: JSON.stringify(['stat_time_day']), metrics: JSON.stringify(['impressions', 'clicks']), start_date: chartStartDate, end_date: input.endDate, page: '1', page_size: '1000' };
  // Data is always fetched from the official Ads API. A dedicated API token is
  // preferred; the existing OAuth token is only used as credential fallback,
  // never as an MCP report call.
  const accessToken = env.TIKTOK_ADS_ACCESS_TOKEN || await getAccessToken(env);
  const rows: any[] = [];
  for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
    url.searchParams.set('page', String(page)); Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url.toString(), { headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' } });
    const raw = await response.text(); let body: any = {}; try { body = JSON.parse(raw); } catch { /* error below includes status */ }
    if (!response.ok || Number(body?.code) !== 0) throw new Error(`TikTok Ads API: ${body?.message || body?.msg || `HTTP ${response.status}`}`);
    rows.push(...responseRows(body));
    totalPages = Math.min(20, Number(body?.data?.page_info?.total_page ?? body?.data?.page_info?.total_pages ?? 1) || 1);
  }
  const points = dailyPoints(chartStartDate, input.endDate), byDate = new Map(points.map((point) => [point.key, point.metrics]));
  for (const row of rows) { const metrics = byDate.get(rowDate(row)); if (!metrics) continue; const values = row?.metrics || row || {}; metrics.impressions += numberValue(values.impressions); metrics.clicks += numberValue(values.clicks); }
  points.forEach((point) => { point.metrics.traffic = point.metrics.clicks; });
  const result = { generatedAt: new Date().toISOString(), source: 'tiktok_ads_api', granularity: 'day', chartStartDate, points };
  await cachePut(env, cacheKey, result, 300); return result;
}
