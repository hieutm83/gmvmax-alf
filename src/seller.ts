import type { Env, SellerTokenSet } from './types';
import { decryptJson, encryptJson } from './crypto';
import { cacheGet, cachePut, dateInTimezone, HttpError, numberValue, randomBase64Url, shiftDate, stableKey } from './utils';

const SELLER_TOKEN_KEY = 'seller_oauth_tokens';
const SHOP_API = 'https://open-api.tiktokglobalshop.com';
const SHOP_AUTH_API = 'https://auth.tiktok-shops.com/api/v2';

function configured(env: Env): boolean {
  return Boolean(env.TIKTOK_SHOP_APP_KEY && env.TIKTOK_SHOP_APP_SECRET);
}

function requireConfig(env: Env): void {
  if (!configured(env)) throw new HttpError(503,
    'Chưa cấu hình TikTok Shop Seller OAuth. Cần TIKTOK_SHOP_APP_KEY và TIKTOK_SHOP_APP_SECRET.');
}

async function setting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  return row?.value || null;
}

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
}

function expiry(value: unknown, fallbackSeconds: number): number {
  const numeric = Number(value);
  if (!numeric) return Date.now() + fallbackSeconds * 1000;
  return numeric > 10_000_000_000 ? numeric : numeric > 1_000_000_000 ? numeric * 1000 : Date.now() + numeric * 1000;
}

function tokenFrom(data: any, previous?: SellerTokenSet): SellerTokenSet {
  if (!data?.access_token) throw new Error('TikTok Shop OAuth không trả access_token.');
  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token || previous?.refreshToken || ''),
    accessTokenExpiresAt: expiry(data.access_token_expire_in, 7 * 86400),
    refreshTokenExpiresAt: expiry(data.refresh_token_expire_in, 365 * 86400),
    openId: data.open_id ? String(data.open_id) : previous?.openId,
    sellerName: data.seller_name || previous?.sellerName,
    grantedScopes: data.granted_scopes || data.granted_permissions || previous?.grantedScopes || []
  };
}

async function saveSellerTokens(env: Env, tokens: SellerTokenSet): Promise<void> {
  await putSetting(env, SELLER_TOKEN_KEY, await encryptJson(env, tokens));
}

export async function readSellerTokens(env: Env): Promise<SellerTokenSet | null> {
  const raw = await setting(env, SELLER_TOKEN_KEY);
  return raw ? decryptJson<SellerTokenSet>(env, raw) : null;
}

async function tokenRequest(env: Env, path: 'get' | 'refresh', params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams({ app_key: env.TIKTOK_SHOP_APP_KEY!, app_secret: env.TIKTOK_SHOP_APP_SECRET!, ...params });
  const response = await fetch(`${SHOP_AUTH_API}/token/${path}?${query}`);
  const payload = await response.json<any>().catch(() => ({}));
  if (!response.ok || Number(payload.code) !== 0) throw new Error(payload.message || `TikTok Shop OAuth HTTP ${response.status}`);
  return payload.data || {};
}

export async function createSellerAuthorizationUrl(env: Env): Promise<string> {
  requireConfig(env);
  if (!env.TIKTOK_SHOP_SERVICE_ID) throw new HttpError(503,
    'Chưa có TIKTOK_SHOP_SERVICE_ID. Hãy mở Partner Center để cấp quyền hoặc bổ sung Service ID.');
  const state = randomBase64Url(32);
  await env.DB.prepare('INSERT INTO seller_oauth_states(state,expires_at) VALUES(?,?)')
    .bind(state, Date.now() + 30 * 60_000).run();
  const query = new URLSearchParams({ service_id: env.TIKTOK_SHOP_SERVICE_ID!, state });
  return `https://services.tiktokshop.com/open/authorize?${query}`;
}

export async function handleSellerOAuthCallback(env: Env, url: URL): Promise<Response> {
  try {
    requireConfig(env);
    const callbackAppKey = url.searchParams.get('app_key');
    if (callbackAppKey && callbackAppKey !== env.TIKTOK_SHOP_APP_KEY) throw new Error('App Key trong callback không khớp ứng dụng đã cấu hình.');
    const state = url.searchParams.get('state') || '';
    const row = state ? await env.DB.prepare('SELECT expires_at FROM seller_oauth_states WHERE state=?')
      .bind(state).first<{ expires_at: number }>() : null;
    if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error')!);
    if (state && (!row || row.expires_at < Date.now())) throw new Error('Phiên TikTok Shop OAuth không hợp lệ hoặc đã hết hạn.');
    if (!state && callbackAppKey !== env.TIKTOK_SHOP_APP_KEY) throw new Error('Callback Seller thiếu state hoặc app_key hợp lệ.');
    const code = url.searchParams.get('code'); if (!code) throw new Error('TikTok Shop không trả authorization code.');
    const data = await tokenRequest(env, 'get', { auth_code: code, grant_type: 'authorized_code' });
    if (data.user_type != null && Number(data.user_type) !== 0) throw new Error('Token nhận được không phải Seller token.');
    await saveSellerTokens(env, tokenFrom(data));
    if (state) await env.DB.prepare('DELETE FROM seller_oauth_states WHERE state=?').bind(state).run();
    return Response.redirect(`${url.origin}/?seller_connected=1`, 302);
  } catch (error) {
    return new Response(`TikTok Shop OAuth: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function sellerAccessToken(env: Env): Promise<string> {
  requireConfig(env);
  const tokens = await readSellerTokens(env);
  if (!tokens) throw new HttpError(401, 'Chưa kết nối TikTok Shop Seller.');
  if (tokens.accessTokenExpiresAt > Date.now() + 5 * 60_000) return tokens.accessToken;
  if (!tokens.refreshToken || tokens.refreshTokenExpiresAt <= Date.now()) throw new HttpError(401, 'Ủy quyền TikTok Shop Seller đã hết hạn.');
  const data = await tokenRequest(env, 'refresh', { refresh_token: tokens.refreshToken, grant_type: 'refresh_token' });
  const refreshed = tokenFrom(data, tokens); await saveSellerTokens(env, refreshed); return refreshed.accessToken;
}

export async function sellerOAuthState(env: Env): Promise<any> {
  const tokens = configured(env) ? await readSellerTokens(env) : null;
  return { configured: configured(env), canAuthorize: Boolean(configured(env) && env.TIKTOK_SHOP_SERVICE_ID), connected: Boolean(tokens), expiresAt: tokens?.accessTokenExpiresAt || null,
    refreshExpiresAt: tokens?.refreshTokenExpiresAt || null, sellerName: tokens?.sellerName || '',
    grantedScopes: tokens?.grantedScopes || [], storage: 'Encrypted D1' };
}

export async function disconnectSeller(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(SELLER_TOKEN_KEY).run();
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function shopRequest(env: Env, path: string, method: 'GET' | 'POST', query: Record<string, any>, body?: any): Promise<any> {
  const accessToken = await sellerAccessToken(env);
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = { app_key: env.TIKTOK_SHOP_APP_KEY!, timestamp: String(timestamp) };
  Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') params[key] = String(value); });
  const bodyText = body == null ? '' : JSON.stringify(body);
  const joined = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  const base = `${env.TIKTOK_SHOP_APP_SECRET}${path}${joined}${bodyText}${env.TIKTOK_SHOP_APP_SECRET}`;
  params.sign = await hmacHex(env.TIKTOK_SHOP_APP_SECRET!, base);
  const response = await fetch(`${SHOP_API}${path}?${new URLSearchParams(params)}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body: method === 'POST' ? bodyText : undefined
  });
  const payload = await response.json<any>().catch(() => ({}));
  if (!response.ok || Number(payload.code) !== 0) {
    const requestId = payload.request_id ? ` · request_id ${payload.request_id}` : '';
    throw new Error(`TikTok Shop API ${path}: ${payload.message || `HTTP ${response.status}`}${requestId}`);
  }
  return payload.data || {};
}

async function authorizedShop(env: Env): Promise<any> {
  const data = await shopRequest(env, '/authorization/202309/shops', 'GET', {});
  const shops = data.shops || data.shop_list || [];
  const wanted = String(env.DEFAULT_STORE_CODE || '').toUpperCase();
  return shops.find((shop: any) => [shop.code, shop.shop_code, shop.name].some((value) => String(value || '').toUpperCase().includes(wanted))) || shops[0];
}

function epoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00+07:00`) / 1000);
}

async function ordersForPeriod(env: Env, startDate: string, endDate: string, shopCipher: string): Promise<any[]> {
  const orders: any[] = []; let pageToken = ''; let pages = 0;
  do {
    const data = await shopRequest(env, '/order/202309/orders/search', 'POST', {
      shop_cipher: shopCipher, page_size: 100, page_token: pageToken || undefined,
      sort_field: 'create_time', sort_order: 'ASC'
    }, { create_time_ge: epoch(startDate), create_time_lt: epoch(shiftDate(endDate, 1)) });
    orders.push(...(data.orders || [])); pageToken = String(data.next_page_token || ''); pages += 1;
  } while (pageToken && pages < 100);
  return orders;
}

async function hydrateMissingOrderAddresses(env: Env, orders: any[], shopCipher: string): Promise<any[]> {
  const missingIds = orders
    .filter((order) => {
      const status = String(order.status || '').toUpperCase();
      const address = order.recipient_address || {};
      return order.id && !/UNPAID|ON_HOLD/.test(status) &&
        (!Array.isArray(address.district_info) || !address.district_info.length) && !address.state && !address.province;
    })
    .map((order) => String(order.id));
  if (!missingIds.length) return orders;

  const details = new Map<string, any>();
  for (let offset = 0; offset < missingIds.length; offset += 50) {
    const ids = missingIds.slice(offset, offset + 50);
    const data = await shopRequest(env, '/order/202507/orders', 'GET', {
      shop_cipher: shopCipher,
      ids: ids.join(',')
    });
    for (const order of data.orders || []) details.set(String(order.id), order);
  }
  return orders.map((order) => details.has(String(order.id)) ? { ...order, ...details.get(String(order.id)) } : order);
}

async function shopPerformance(env: Env, startDate: string, endDate: string, shopCipher: string): Promise<any | null> {
  try {
    return await shopRequest(env, '/analytics/202509/shop/performance', 'GET', {
      shop_cipher: shopCipher,
      start_date_ge: startDate,
      end_date_lt: shiftDate(endDate, 1),
      granularity: '1D',
      currency: 'LOCAL'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/access denied|required access scope|not authorized/i.test(message)) return null;
    throw error;
  }
}

function gmvAmount(value: any): number {
  return numberValue(value?.amount ?? value);
}

async function productGmvAttribution(env: Env, startDate: string, endDate: string, shopCipher: string): Promise<any | null> {
  const totals = {
    total: 0,
    affiliate: { total: 0, live: 0, video: 0, productCard: 0 },
    seller: { total: 0, live: 0, video: 0, productCard: 0 }
  };
  let pageToken = ''; let pages = 0; let latestAvailableDate: string | null = null;
  try {
    do {
      const data = await shopRequest(env, '/analytics/202605/shop_products/performance', 'GET', {
        shop_cipher: shopCipher,
        start_date_ge: startDate,
        end_date_lt: shiftDate(endDate, 1),
        page_size: 100,
        page_token: pageToken || undefined,
        sort_field: 'gmv',
        sort_order: 'DESC',
        currency: 'LOCAL',
        product_status_filter: 'ALL'
      });
      latestAvailableDate = data.latest_available_date || latestAvailableDate;
      for (const product of data.products || []) {
        const affiliateTotal = gmvAmount(product.affiliate_total_performance?.attributed_gmv);
        const affiliateLive = Math.min(affiliateTotal, gmvAmount(product.affiliate_live_performance?.live_attributed_gmv));
        const affiliateVideo = Math.min(Math.max(0, affiliateTotal - affiliateLive),
          gmvAmount(product.affiliate_video_performance?.attributed_video_gmv));
        const sellerLive = gmvAmount(product.seller_live_performance?.attributed_gmv);
        const sellerVideo = gmvAmount(product.seller_video_performance?.attributed_gmv);
        const sellerProductCard = gmvAmount(product.seller_product_card_performance?.attributed_gmv);
        totals.total += gmvAmount(product.total_performance?.gmv);
        totals.affiliate.total += affiliateTotal;
        totals.affiliate.live += affiliateLive;
        totals.affiliate.video += affiliateVideo;
        totals.affiliate.productCard += Math.max(0, affiliateTotal - affiliateLive - affiliateVideo);
        totals.seller.live += sellerLive;
        totals.seller.video += sellerVideo;
        totals.seller.productCard += sellerProductCard;
      }
      pageToken = String(data.next_page_token || ''); pages += 1;
    } while (pageToken && pages < 100);
    totals.seller.total = totals.seller.live + totals.seller.video + totals.seller.productCard;
    return { ...totals, attributedTotal: totals.affiliate.total + totals.seller.total, latestAvailableDate };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/access denied|required access scope|not authorized/i.test(message)) return null;
    throw error;
  }
}

function province(order: any): string {
  const address = order.recipient_address || {};
  const list = address.district_info || address.district_info_list || address.district_infos || [];
  const region = list.find((item: any) => /^(L1|LEVEL_1)$/i.test(String(item.address_level || item.level || ''))) ||
    list.find((item: any) => /PROVINCE|STATE|TỈNH|THÀNH PHỐ/i.test(String(item.address_level_name || item.address_type || ''))) ||
    list.find((item: any) => !/^L0$/i.test(String(item.address_level || item.level || ''))) || list[0];
  return String(region?.address_name || region?.name || address.state || address.province || 'Không xác định');
}

function summarizeOrders(env: Env, orders: any[], startDate: string, endDate: string): any {
  const daily = new Map<string, any>();
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) daily.set(date, { date, orders: 0, cancelledOrders: 0, grossRevenue: 0, aov: null, newCustomers: 0, returningCustomers: 0 });
  const customers = new Map<string, number>(); const provinces = new Map<string, number>();
  const sorted = orders.slice().sort((a, b) => numberValue(a.create_time) - numberValue(b.create_time));
  for (const order of sorted) {
    const date = dateInTimezone(new Date(numberValue(order.create_time) * 1000), env.TIMEZONE); const point = daily.get(date); if (!point) continue;
    const status = String(order.status || '').toUpperCase(); const cancelled = /CANCEL/.test(status);
    if (cancelled) { point.cancelledOrders += 1; continue; }
    if (/UNPAID/.test(status)) continue;
    const amount = numberValue(order.payment?.total_amount ?? order.payment?.original_total_product_price ?? order.total_amount);
    const customer = String(order.user_id || order.buyer_user_id || order.recipient_address?.phone_number || order.id);
    const previous = customers.get(customer) || 0; customers.set(customer, previous + 1);
    if (previous) point.returningCustomers += 1; else point.newCustomers += 1;
    point.orders += 1; point.grossRevenue += amount;
    const region = province(order); provinces.set(region, (provinces.get(region) || 0) + amount);
  }
  const points = Array.from(daily.values()); points.forEach((point) => { point.aov = point.orders ? point.grossRevenue / point.orders : null; });
  const totals = points.reduce((sum, point) => ({ orders: sum.orders + point.orders, cancelledOrders: sum.cancelledOrders + point.cancelledOrders,
    grossRevenue: sum.grossRevenue + point.grossRevenue }), { orders: 0, cancelledOrders: 0, grossRevenue: 0 });
  const repeatCustomers = Array.from(customers.values()).filter((count) => count > 1).length;
  return { daily: points, totals: { ...totals, aov: totals.orders ? totals.grossRevenue / totals.orders : null,
    repurchaseRate: customers.size ? repeatCustomers / customers.size : null },
    provinces: Array.from(provinces, ([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 10) };
}

function applyShopPerformance(summary: any, data: any): any {
  const intervals = data?.performance?.intervals;
  if (!Array.isArray(intervals) || !intervals.length) return summary;
  const latestAvailableDate = String(data.latest_available_date || '');
  const byDate = new Map(intervals.map((interval: any) => [String(interval.start_date || ''), interval]));
  for (const point of summary.daily) {
    if (latestAvailableDate && point.date > latestAvailableDate) continue;
    const interval: any = byDate.get(point.date);
    if (!interval) continue;
    const sales = interval.sales || {};
    point.grossRevenue = numberValue(sales.gmv?.overall?.amount);
    point.orders = numberValue(sales.orders_count);
    point.aov = point.orders ? point.grossRevenue / point.orders : null;
  }
  const totals = summary.daily.reduce((result: any, point: any) => ({
    orders: result.orders + numberValue(point.orders),
    cancelledOrders: result.cancelledOrders + numberValue(point.cancelledOrders),
    grossRevenue: result.grossRevenue + numberValue(point.grossRevenue)
  }), { orders: 0, cancelledOrders: 0, grossRevenue: 0 });
  summary.totals = {
    ...summary.totals,
    ...totals,
    aov: totals.orders ? totals.grossRevenue / totals.orders : null
  };
  summary.analyticsAvailable = true;
  summary.latestAvailableDate = latestAvailableDate || null;
  return summary;
}

export async function loadSellerRevenueAnalysis(env: Env, input: any): Promise<any> {
  const cacheScope = { startDate: input.startDate, endDate: input.endDate };
  const key = stableKey('seller-revenue-v6', cacheScope);
  const cached = input.forceRefresh === true ? null : await cacheGet<any>(env, key);
  if (cached) return cached;
  const shop = await authorizedShop(env); if (!shop) throw new Error('Seller OAuth chưa trả về TikTok Shop được ủy quyền.');
  const cipher = String(shop.cipher || shop.shop_cipher || shop.id || ''); if (!cipher) throw new Error('Không tìm thấy shop_cipher.');
  const days = Math.floor((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1;
  const chartStartDate = days === 1 ? shiftDate(input.endDate, -6) : input.startDate;
  const previousEndDate = shiftDate(input.startDate, -1); const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const [currentOrders, previousOrders, currentPerformance, previousPerformance, currentAttribution, previousAttribution] = await Promise.all([
    ordersForPeriod(env, chartStartDate, input.endDate, cipher),
    ordersForPeriod(env, previousStartDate, previousEndDate, cipher),
    shopPerformance(env, chartStartDate, input.endDate, cipher),
    shopPerformance(env, previousStartDate, previousEndDate, cipher),
    productGmvAttribution(env, input.startDate, input.endDate, cipher),
    productGmvAttribution(env, previousStartDate, previousEndDate, cipher)
  ]);
  const currentOrdersWithAddresses = await hydrateMissingOrderAddresses(env, currentOrders, cipher);
  const current = applyShopPerformance(summarizeOrders(env, currentOrdersWithAddresses, input.startDate, input.endDate), currentPerformance);
  const charts = chartStartDate === input.startDate ? current :
    applyShopPerformance(summarizeOrders(env, currentOrdersWithAddresses, chartStartDate, input.endDate), currentPerformance);
  const previous = applyShopPerformance(summarizeOrders(env, previousOrders, previousStartDate, previousEndDate), previousPerformance);
  const result = { startDate: input.startDate, endDate: input.endDate, chartStartDate, previousStartDate, previousEndDate,
    generatedAt: new Date().toISOString(), source: 'TIKTOK_SHOP_SELLER', shop: { name: shop.name || shop.shop_name, code: shop.code || shop.shop_code },
    totals: current.totals, previousTotals: previous.totals, daily: charts.daily, provinces: charts.provinces,
    gmvAttribution: currentAttribution, previousGmvAttribution: previousAttribution,
    analyticsAvailable: Boolean(current.analyticsAvailable), latestAvailableDate: current.latestAvailableDate || null };
  await cachePut(env, key, result, 300); return result;
}
