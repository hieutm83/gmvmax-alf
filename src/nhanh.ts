import type { Env, NhanhTokenSet } from './types';
import { decryptJson, encryptJson } from './crypto';
import { cacheGet, cachePut, dateInTimezone, HttpError, numberValue, shiftDate, stableKey } from './utils';

const TOKEN_KEY = 'nhanh_oauth_tokens';
const API_ROOT = 'https://pos.open.nhanh.vn/v3.0';
const CANCELLED_STATUSES = new Set([58, 61, 63, 64, 68, 71, 72, 74]);

function configured(env: Env): boolean {
  return Boolean(env.NHANH_APP_ID && env.NHANH_SECRET_KEY);
}

function requireConfig(env: Env): void {
  if (!configured(env)) throw new HttpError(503, 'Chưa cấu hình NHANH_APP_ID và NHANH_SECRET_KEY trong Cloudflare.');
}

async function setting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  return row?.value || null;
}

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
}

export async function readNhanhTokens(env: Env): Promise<NhanhTokenSet | null> {
  const raw = await setting(env, TOKEN_KEY);
  return raw ? decryptJson<NhanhTokenSet>(env, raw) : null;
}

async function saveTokens(env: Env, tokens: NhanhTokenSet): Promise<void> {
  await putSetting(env, TOKEN_KEY, await encryptJson(env, tokens));
}

export function createNhanhAuthorizationUrl(env: Env, origin: string): string {
  requireConfig(env);
  const returnLink = `${env.PUBLIC_BASE_URL || origin}/nhanh/callback`;
  return `https://nhanh.vn/oauth?${new URLSearchParams({ version: '3.0', appId: env.NHANH_APP_ID!, returnLink })}`;
}

export async function handleNhanhCallback(env: Env, url: URL): Promise<Response> {
  try {
    requireConfig(env);
    const accessCode = url.searchParams.get('accessCode');
    if (!accessCode) throw new Error('Nhanh.vn không trả accessCode hoặc người dùng đã từ chối cấp quyền.');
    const response = await fetch(`${API_ROOT}/app/getaccesstoken?appId=${encodeURIComponent(env.NHANH_APP_ID!)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode, secretKey: env.NHANH_SECRET_KEY })
    });
    const payload = await response.json<any>().catch(() => ({}));
    if (!response.ok || Number(payload.code) !== 1 || !payload.data?.accessToken) {
      const message = Array.isArray(payload.messages) ? payload.messages.join(', ') : payload.message || payload.messages;
      throw new Error(message || `Nhanh.vn OAuth HTTP ${response.status}`);
    }
    const data = payload.data;
    await saveTokens(env, {
      accessToken: String(data.accessToken), expiresAt: numberValue(data.expiredAt) * 1000,
      businessId: String(data.businessId), depotIds: data.depotIds || [], pageIds: data.pageIds || [],
      permissions: data.permissions || []
    });
    return Response.redirect(`${url.origin}/?nhanh_connected=1`, 302);
  } catch (error) {
    return new Response(`Nhanh.vn OAuth: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

export async function nhanhOAuthState(env: Env): Promise<any> {
  const token = configured(env) ? await readNhanhTokens(env) : null;
  return { configured: configured(env), connected: Boolean(token && token.expiresAt > Date.now()),
    expiresAt: token?.expiresAt || null, businessId: token?.businessId || null,
    permissions: token?.permissions || [], storage: 'Encrypted D1' };
}

export async function disconnectNhanh(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(TOKEN_KEY).run();
}

async function credentials(env: Env): Promise<NhanhTokenSet> {
  requireConfig(env);
  const token = await readNhanhTokens(env);
  if (!token) throw new HttpError(401, 'Chưa kết nối tài khoản Nhanh.vn.');
  if (token.expiresAt <= Date.now()) throw new HttpError(401, 'Access token Nhanh.vn đã hết hạn. Hãy cấp quyền lại.');
  return token;
}

async function orderPage(env: Env, token: NhanhTokenSet, filters: any, next?: any): Promise<any> {
  const response = await fetch(`${API_ROOT}/order/list?${new URLSearchParams({ appId: env.NHANH_APP_ID!, businessId: token.businessId })}`, {
    method: 'POST', headers: { Authorization: token.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters, paginator: { size: 100, ...(next ? { next } : {}) }, dataOptions: {} })
  });
  const payload = await response.json<any>().catch(() => ({}));
  if (!response.ok || Number(payload.code) !== 1) {
    const message = Array.isArray(payload.messages) ? payload.messages.join(', ') : payload.message || JSON.stringify(payload.messages || {});
    throw new Error(message || `Nhanh.vn Order API HTTP ${response.status}`);
  }
  return payload;
}

function epoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00+07:00`) / 1000);
}

async function ordersForPeriod(env: Env, token: NhanhTokenSet, startDate: string, endDate: string): Promise<any[]> {
  const orders: any[] = []; let next: any; let pages = 0;
  const filters = { createdAtFrom: epoch(startDate), createdAtTo: epoch(shiftDate(endDate, 1)) - 1 };
  do {
    const payload = await orderPage(env, token, filters, next);
    orders.push(...(Array.isArray(payload.data) ? payload.data : []));
    next = payload.paginator?.next || null;
    pages += 1;
  } while (next && pages < 200);
  return orders;
}

function orderAmount(order: any): number {
  const products = Array.isArray(order.products) ? order.products : [];
  const productAmount = products.reduce((sum: number, product: any) => sum + numberValue(product.totalAmount), 0);
  return productAmount || numberValue(order.payment?.codAmount || order.totalAmount);
}

function province(order: any): string {
  const location = String(order.shippingAddress?.location || '').trim();
  if (location) return location.split(',').map((part) => part.trim()).filter(Boolean).at(-1) || 'Không xác định';
  return String(order.shippingAddress?.cityName || order.shippingAddress?.city || 'Không xác định');
}

function customerId(order: any): string {
  const address = order.shippingAddress || {};
  return String(address.id || address.mobile || address.email || order.info?.id || '');
}

function summarize(env: Env, orders: any[], startDate: string, endDate: string, knownCustomers = new Set<string>()): any {
  const daily = new Map<string, any>();
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) {
    daily.set(date, { date, orders: 0, cancelledOrders: 0, grossRevenue: 0, aov: null, newCustomers: 0, returningCustomers: 0 });
  }
  const seen = new Set(knownCustomers); const customers = new Map<string, number>(); const returning = new Set<string>(); const provinces = new Map<string, number>();
  const sorted = orders.slice().sort((a, b) => numberValue(a.info?.createdAt) - numberValue(b.info?.createdAt));
  for (const order of sorted) {
    const timestamp = numberValue(order.info?.createdAt || order.createdAt);
    const date = dateInTimezone(new Date(timestamp * 1000), env.TIMEZONE); const point = daily.get(date); if (!point) continue;
    if (CANCELLED_STATUSES.has(numberValue(order.info?.status ?? order.status))) { point.cancelledOrders += 1; continue; }
    const amount = orderAmount(order); const customer = customerId(order);
    if (customer) {
      if (seen.has(customer)) { point.returningCustomers += 1; returning.add(customer); } else point.newCustomers += 1;
      seen.add(customer); customers.set(customer, (customers.get(customer) || 0) + 1);
    }
    point.orders += 1; point.grossRevenue += amount;
    const region = province(order); provinces.set(region, (provinces.get(region) || 0) + amount);
  }
  const points = Array.from(daily.values()); points.forEach((point) => { point.aov = point.orders ? point.grossRevenue / point.orders : null; });
  const totals = points.reduce((sum, point) => ({ orders: sum.orders + point.orders, cancelledOrders: sum.cancelledOrders + point.cancelledOrders,
    grossRevenue: sum.grossRevenue + point.grossRevenue }), { orders: 0, cancelledOrders: 0, grossRevenue: 0 });
  return { daily: points, customerIds: new Set([...knownCustomers, ...customers.keys()]), totals: { ...totals,
    aov: totals.orders ? totals.grossRevenue / totals.orders : null,
    repurchaseRate: customers.size ? returning.size / customers.size : null },
    provinces: Array.from(provinces, ([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 10) };
}

export async function loadNhanhRevenueAnalysis(env: Env, input: any): Promise<any> {
  const key = stableKey('nhanh-revenue-v1', input); const cached = await cacheGet<any>(env, key); if (cached) return cached;
  const token = await credentials(env);
  const days = Math.floor((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > 31) throw new HttpError(400, 'Nhanh.vn chỉ cho phép lấy đơn hàng trong tối đa 31 ngày.');
  const previousEndDate = shiftDate(input.startDate, -1); const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const [previousOrders, currentOrders] = await Promise.all([
    ordersForPeriod(env, token, previousStartDate, previousEndDate), ordersForPeriod(env, token, input.startDate, input.endDate)
  ]);
  const previous = summarize(env, previousOrders, previousStartDate, previousEndDate);
  const current = summarize(env, currentOrders, input.startDate, input.endDate, previous.customerIds);
  const result = { startDate: input.startDate, endDate: input.endDate, previousStartDate, previousEndDate,
    generatedAt: new Date().toISOString(), source: 'NHANH_VN', businessId: token.businessId,
    totals: current.totals, previousTotals: previous.totals, daily: current.daily, provinces: current.provinces };
  await cachePut(env, key, result, 300); return result;
}

export async function receiveNhanhWebhook(request: Request, env: Env): Promise<Response> {
  const payload = await request.json<any>().catch(() => null);
  if (!payload) return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const supplied = payload.webhooksVerifyToken || payload.webhookVerifyToken || payload.verifyToken;
  if (env.NHANH_WEBHOOK_VERIFY_TOKEN && supplied !== env.NHANH_WEBHOOK_VERIFY_TOKEN) throw new HttpError(401, 'Webhook verify token không hợp lệ.');
  const eventType = String(payload.event || payload.type || payload.eventType || 'unknown');
  const externalId = String(payload.data?.id || payload.id || '');
  await env.DB.prepare('INSERT INTO nhanh_webhook_events(event_type,external_id,payload,received_at) VALUES(?,?,?,?)')
    .bind(eventType, externalId || null, JSON.stringify(payload), Date.now()).run();
  return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
