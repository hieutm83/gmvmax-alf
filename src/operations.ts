import type { Env } from './types';
import { authorizedShop, epoch, ordersForPeriod, shopRequest } from './seller';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

const TRACKING_CONCURRENCY = 8;
const STUCK_RETURN_DAYS = 3;
const FAILURE_CODES = new Set(['40601', '40801', '41801', '41901', '60101', '70201', '70301', '70401', '70501']);
const RECEIVED_CODES = new Set(['43101', '43201', '60201', '80101']);

const ACTION_LABELS: Record<string, string> = {
  '40601': 'Giao thất bại lần 1',
  '40801': 'Giao thất bại lần 2',
  '41801': 'Giao thất bại lần 3',
  '41901': 'Giao thất bại nhiều lần',
  '60101': 'Giao hàng thất bại',
  '70201': 'Đang chuyển hoàn về người gửi',
  '70301': 'Quá trình hoàn hàng gặp sự cố',
  '70401': 'Chuyển hoàn thất bại',
  '70501': 'Kiện hàng hoàn bị thất lạc',
  '43101': 'Kho đã xác nhận nhận lại hàng',
  '43201': 'Kiện hoàn đã vào kho',
  '60201': 'Đã hoàn về người gửi',
  '80101': 'Đơn đã đóng'
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderAmount(order: any): number {
  return numberValue(order?.payment?.total_amount ?? order?.payment?.original_total_product_price ?? order?.total_amount);
}

async function pagedSearch(env: Env, path: string, listKey: string, shopCipher: string,
  startDate: string, endDate: string): Promise<any[]> {
  const rows: any[] = [];
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env, path, 'POST', {
      shop_cipher: shopCipher,
      page_size: 50,
      page_token: pageToken || undefined,
      sort_field: 'update_time',
      sort_order: 'DESC'
    }, {
      create_time_ge: epoch(startDate),
      create_time_lt: epoch(shiftDate(endDate, 1)),
      locale: 'vi-VN'
    });
    rows.push(...(Array.isArray(data?.[listKey]) ? data[listKey] : []));
    pageToken = String(data?.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);
  return rows;
}

async function trackingForOrder(env: Env, orderId: string, shopCipher: string): Promise<any> {
  const key = stableKey('shop-tracking-v1', { orderId, shopCipher });
  const cached = await cacheGet<any>(env, key);
  if (cached) return cached;
  const data = await shopRequest(env, `/logistics/202604/orders/${orderId}/tracking`, 'GET', { shop_cipher: shopCipher });
  await cachePut(env, key, data, 900);
  return data;
}

async function mapConcurrent<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function trackingEvents(data: any): any[] {
  const events: any[] = [];
  for (const parcel of data?.logistics_details || []) {
    for (const event of parcel?.track_list || []) {
      events.push({ ...event, carrierName: parcel?.carrier_name || '', trackingNumber: event?.tracking_no || parcel?.newest_tracking_no || '' });
    }
  }
  return events.sort((left, right) => numberValue(left.update_time_millis) - numberValue(right.update_time_millis));
}

function failedReason(event: any): string {
  const code = String(event?.action_code || '');
  const source = `${event?.description || ''} ${event?.action_code_name || ''}`.toLowerCase();
  if (/refus|từ chối/.test(source)) return 'Khách từ chối nhận hàng';
  if (/address|địa chỉ/.test(source)) return 'Địa chỉ không hợp lệ';
  if (/weather|force majeure|bất khả kháng|thiên tai/.test(source)) return 'Bất khả kháng';
  if (/unreachable|contact|phone|liên lạc|nghe máy/.test(source)) return 'Không liên lạc được người nhận';
  return ACTION_LABELS[code] || event?.description || event?.action_code_name || `Mã logistics ${code}`;
}

function addCount(map: Map<string, number>, label: string): void {
  const key = label || 'Không xác định';
  map.set(key, (map.get(key) || 0) + 1);
}

function breakdown(map: Map<string, number>): Array<{ label: string; count: number }> {
  return Array.from(map, ([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count);
}

function latestTimestamp(...values: unknown[]): number {
  return Math.max(0, ...values.map(numberValue));
}

export async function loadOperationsAnalysis(env: Env, input: any): Promise<any> {
  const key = stableKey('seller-operations-v1', { startDate: input.startDate, endDate: input.endDate });
  const cached = input.forceRefresh === true ? null : await cacheGet<any>(env, key);
  if (cached) return cached;

  const shop = await authorizedShop(env);
  if (!shop) throw new Error('Seller OAuth chưa trả về TikTok Shop được ủy quyền.');
  const cipher = String(shop.cipher || shop.shop_cipher || shop.id || '');
  if (!cipher) throw new Error('Không tìm thấy shop_cipher.');

  const warnings: string[] = [];
  const orders = await ordersForPeriod(env, input.startDate, input.endDate, cipher);
  const orderById = new Map(orders.map((order) => [String(order.id || order.order_id || ''), order]));

  const [cancellations, returns] = await Promise.all([
    pagedSearch(env, '/return_refund/202602/cancellations/search', 'cancellations', cipher, input.startDate, input.endDate)
      .catch((error) => { warnings.push(`Hủy đơn: ${errorMessage(error)}`); return []; }),
    pagedSearch(env, '/return_refund/202602/returns/search', 'return_orders', cipher, input.startDate, input.endDate)
      .catch((error) => { warnings.push(`Trả hàng/hoàn tiền: ${errorMessage(error)}`); return []; })
  ]);

  const shippableOrders = orders.filter((order) => /IN_TRANSIT|DELIVERED|COMPLETED|SHIPPED/.test(String(order.status || '').toUpperCase()));
  let trackingFailures = 0;
  let firstTrackingError = '';
  let trackingAllowed = true;
  const tracked: Array<{ order: any; events: any[] }> = [];
  if (shippableOrders.length) {
    try {
      const firstOrder = shippableOrders[0];
      const firstId = String(firstOrder.id || firstOrder.order_id || '');
      tracked.push({ order: firstOrder, events: trackingEvents(await trackingForOrder(env, firstId, cipher)) });
    } catch (error) {
      trackingFailures += 1;
      firstTrackingError = errorMessage(error);
      if (/access denied|required access scope|not authorized/i.test(errorMessage(error))) {
        trackingAllowed = false;
        warnings.push(`Logistics: ${errorMessage(error)}`);
      }
    }
    if (trackingAllowed) {
      tracked.push(...await mapConcurrent(shippableOrders.slice(1), TRACKING_CONCURRENCY, async (order) => {
        try {
          const id = String(order.id || order.order_id || '');
          return { order, events: trackingEvents(await trackingForOrder(env, id, cipher)) };
        } catch (error) {
          trackingFailures += 1;
          if (!firstTrackingError) firstTrackingError = errorMessage(error);
          return { order, events: [] };
        }
      }));
    }
  }
  if (trackingAllowed && trackingFailures) warnings.push(`Không đọc được tracking của ${trackingFailures}/${shippableOrders.length} đơn${firstTrackingError ? `: ${firstTrackingError}` : ''}.`);

  const cancellationRoles = { BUYER: 0, SYSTEM: 0, SELLER: 0 };
  const returnTypes: Record<string, number> = { REFUND: 0, RETURN_AND_REFUND: 0 };
  const cancelReasons = new Map<string, number>();
  const returnReasons = new Map<string, number>();
  const failedReasons = new Map<string, number>();
  const atRiskOrderIds = new Set<string>();
  const incidents: any[] = [];

  for (const item of cancellations) {
    const orderId = String(item.order_id || '');
    const role = String(item.role || 'SYSTEM').toUpperCase();
    if (role in cancellationRoles) cancellationRoles[role as keyof typeof cancellationRoles] += 1;
    const reason = String(item.cancel_reason_text || item.cancel_reason || 'Không xác định');
    addCount(cancelReasons, reason);
    if (orderId) atRiskOrderIds.add(orderId);
    incidents.push({ id: String(item.cancel_id || orderId), orderId, rmaId: String(item.cancel_id || ''), type: 'Hủy đơn', group: role,
      reason, status: String(item.cancel_status || ''), actionCode: '', updatedAt: latestTimestamp(item.update_time, item.create_time) * 1000 });
  }

  for (const item of returns) {
    const orderId = String(item.order_id || '');
    const type = String(item.return_type || 'OTHER').toUpperCase();
    returnTypes[type] = (returnTypes[type] || 0) + 1;
    const reason = String(item.return_reason_text || item.return_reason || 'Không xác định');
    addCount(returnReasons, reason);
    if (orderId) atRiskOrderIds.add(orderId);
    incidents.push({ id: String(item.return_id || orderId), orderId, rmaId: String(item.return_id || ''), type: type === 'REFUND' ? 'Hoàn tiền' : 'Trả hàng',
      group: String(item.role || 'BUYER'), reason, status: String(item.return_status || ''), actionCode: '',
      updatedAt: latestTimestamp(item.update_time, item.create_time) * 1000 });
  }

  const funnelCodes = ['40601', '40801', '41801', '70201', '43101'];
  const funnelCount = new Map(funnelCodes.map((code) => [code, 0]));
  const stuckReturns: any[] = [];
  const returnFailures: any[] = [];
  let failedDeliveries = 0;

  for (const trackedOrder of tracked) {
    const orderId = String(trackedOrder.order.id || trackedOrder.order.order_id || '');
    const events = trackedOrder.events;
    const codes = new Set(events.map((event) => String(event.action_code || '')));
    funnelCodes.forEach((code) => { if (codes.has(code)) funnelCount.set(code, (funnelCount.get(code) || 0) + 1); });
    const failedEvents = events.filter((event) => FAILURE_CODES.has(String(event.action_code || '')));
    if (!failedEvents.length) continue;
    failedDeliveries += 1;
    atRiskOrderIds.add(orderId);
    const latest = failedEvents.at(-1)!;
    const latestAll = events.at(-1) || latest;
    const reason = failedReason(latest);
    addCount(failedReasons, reason);
    const incident = { id: orderId, orderId, rmaId: '', type: 'Giao thất bại', group: 'LOGISTICS', reason,
      status: String(latestAll.action_code_name || ACTION_LABELS[String(latestAll.action_code || '')] || ''),
      actionCode: String(latestAll.action_code || ''), updatedAt: numberValue(latestAll.update_time_millis) };
    incidents.push(incident);

    const returning = events.filter((event) => String(event.action_code || '') === '70201').at(-1);
    if (returning && !Array.from(RECEIVED_CODES).some((code) => codes.has(code))) {
      const ageDays = Math.floor((Date.now() - numberValue(returning.update_time_millis)) / 86400000);
      if (ageDays > STUCK_RETURN_DAYS) stuckReturns.push({ ...incident, ageDays });
    }
    if (codes.has('70301')) returnFailures.push(incident);
  }

  let atRiskValue = 0;
  for (const orderId of atRiskOrderIds) atRiskValue += orderAmount(orderById.get(orderId));
  incidents.sort((left, right) => numberValue(right.updatedAt) - numberValue(left.updatedAt));

  const totalOrders = orders.length;
  const result = {
    generatedAt: new Date().toISOString(), startDate: input.startDate, endDate: input.endDate,
    shop: { name: shop.name || shop.shop_name, code: shop.code || shop.shop_code }, warnings,
    totals: {
      totalOrders,
      cancellations: cancellations.length,
      cancellationRate: totalOrders ? cancellations.length / totalOrders : 0,
      cancellationRoles,
      returns: returns.length,
      returnRate: totalOrders ? returns.length / totalOrders : 0,
      returnTypes,
      dispatchedOrders: shippableOrders.length,
      failedDeliveries,
      failedDeliveryRate: shippableOrders.length ? failedDeliveries / shippableOrders.length : 0,
      atRiskValue
    },
    cancelReasons: breakdown(cancelReasons),
    returnReasons: breakdown(returnReasons),
    failedReasons: breakdown(failedReasons),
    funnel: funnelCodes.map((code) => ({ code, label: ACTION_LABELS[code], count: funnelCount.get(code) || 0 })),
    alerts: { stuckReturns, returnFailures, stuckThresholdDays: STUCK_RETURN_DAYS },
    incidents
  };
  await cachePut(env, key, result, 300);
  return result;
}
