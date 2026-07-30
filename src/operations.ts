import type { Env } from './types';
import { authorizedShop, epoch, ordersForPeriod, shopRequest } from './seller';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

const TRACKING_CONCURRENCY = 2;
const STUCK_RETURN_DAYS = 3;
const DELIVERY_FAILURE_CODES = new Set(['40601', '40801', '41801', '41901', '60101']);
const RECEIVED_CODES = new Set(['43101', '43201', '60201', '80101']);
const OPEN_ORDER_STATUSES = new Set(['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT']);
const DELIVERY_POPULATION_STATUSES = new Set(['AWAITING_COLLECTION', 'IN_TRANSIT']);

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
  let data: any;
  try {
    data = await shopRequest(env, `/logistics/202604/orders/${orderId}/tracking`, 'GET', { shop_cipher: shopCipher });
  } catch (error) {
    if (!/11007009|not in supported business scenes|not in supported scope/i.test(errorMessage(error))) throw error;
    data = { order_id: orderId, logistics_details: [], unsupported: true };
  }
  await cachePut(env, key, data, 900);
  return data;
}

async function orderDetails(env: Env, orderIds: string[], shopCipher: string): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < orderIds.length; offset += 50) {
    const ids = orderIds.slice(offset, offset + 50);
    if (!ids.length) continue;
    const data = await shopRequest(env, '/order/202507/orders', 'GET', { shop_cipher: shopCipher, ids: ids.join(',') });
    rows.push(...(data.orders || []));
  }
  return rows;
}

function cancellationRefund(item: any): number {
  return numberValue(item?.refund_amount?.refund_total);
}

function returnRefund(item: any): number {
  const lines = Array.isArray(item?.return_line_items) ? item.return_line_items : [];
  const lineTotal = lines.reduce((sum: number, line: any) => sum + numberValue(line?.refund_amount?.refund_total), 0);
  return lineTotal || numberValue(item?.refund_amount?.refund_total);
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

function timestampMillis(value: unknown): number {
  const timestamp = numberValue(value);
  return timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

export async function loadOperationsAnalysis(env: Env, input: any): Promise<any> {
  const key = stableKey('seller-operations-v2', { startDate: input.startDate, endDate: input.endDate });
  const cached = input.forceRefresh === true ? null : await cacheGet<any>(env, key);
  if (cached) return cached;

  const shop = await authorizedShop(env);
  if (!shop) throw new Error('Seller OAuth chưa trả về TikTok Shop được ủy quyền.');
  const cipher = String(shop.cipher || shop.shop_cipher || shop.id || '');
  if (!cipher) throw new Error('Không tìm thấy shop_cipher.');

  const warnings: string[] = [];
  const populationStart = shiftDate(input.endDate, -29);
  const populationOrders = await ordersForPeriod(env, populationStart, input.endDate, cipher);
  const orderById = new Map(populationOrders.map((order) => [String(order.id || order.order_id || ''), order]));

  const [cancellations, returns] = await Promise.all([
    pagedSearch(env, '/return_refund/202602/cancellations/search', 'cancellations', cipher, input.startDate, input.endDate)
      .catch((error) => { warnings.push(`Hủy đơn: ${errorMessage(error)}`); return []; }),
    pagedSearch(env, '/return_refund/202602/returns/search', 'return_orders', cipher, input.startDate, input.endDate)
      .catch((error) => { warnings.push(`Trả hàng/hoàn tiền: ${errorMessage(error)}`); return []; })
  ]);

  const eventOrderIds = Array.from(new Set([...cancellations, ...returns]
    .map((item) => String(item.order_id || '')).filter(Boolean)));
  const missingOrderIds = eventOrderIds.filter((id) => !orderById.has(id));
  if (missingOrderIds.length) {
    try {
      for (const order of await orderDetails(env, missingOrderIds, cipher)) {
        orderById.set(String(order.id || order.order_id || ''), order);
      }
    } catch (error) {
      warnings.push(`Chi tiết đơn hàng: ${errorMessage(error)}`);
    }
  }

  const openOrders = populationOrders.filter((order) => OPEN_ORDER_STATUSES.has(String(order.status || '').toUpperCase()));
  const deliveredOrders = populationOrders.filter((order) => String(order.status || '').toUpperCase() === 'DELIVERED');
  const deliveryPopulation = populationOrders.filter((order) => DELIVERY_POPULATION_STATUSES.has(String(order.status || '').toUpperCase()));
  const rangeStart = epoch(input.startDate) * 1000;
  const rangeEnd = epoch(shiftDate(input.endDate, 1)) * 1000;
  const trackingCandidates = deliveryPopulation.filter((order) => {
    const updatedAt = timestampMillis(order.update_time);
    return updatedAt >= rangeStart && updatedAt < rangeEnd;
  });
  let trackingFailures = 0;
  let firstTrackingError = '';
  const tracked = await mapConcurrent(trackingCandidates, TRACKING_CONCURRENCY, async (order) => {
    try {
      const id = String(order.id || order.order_id || '');
      return { order, events: trackingEvents(await trackingForOrder(env, id, cipher)) };
    } catch (error) {
      trackingFailures += 1;
      if (!firstTrackingError) firstTrackingError = errorMessage(error);
      return { order, events: [] };
    }
  });
  if (trackingFailures) warnings.push(`Không đọc được tracking của ${trackingFailures}/${trackingCandidates.length} đơn có cập nhật trong kỳ${firstTrackingError ? `: ${firstTrackingError}` : ''}.`);

  const cancellationRoles = { BUYER: 0, SYSTEM: 0, SELLER: 0 };
  const returnTypes: Record<string, number> = { REFUND: 0, RETURN_AND_REFUND: 0 };
  const cancelReasons = new Map<string, number>();
  const returnReasons = new Map<string, number>();
  const failedReasons = new Map<string, number>();
  const atRiskOrderIds = new Set<string>();
  const refundByOrderId = new Map<string, number>();
  const incidents: any[] = [];

  for (const item of cancellations) {
    const orderId = String(item.order_id || '');
    const role = String(item.role || 'SYSTEM').toUpperCase();
    if (role in cancellationRoles) cancellationRoles[role as keyof typeof cancellationRoles] += 1;
    const reason = String(item.cancel_reason_text || item.cancel_reason || 'Không xác định');
    addCount(cancelReasons, reason);
    if (orderId) {
      atRiskOrderIds.add(orderId);
      refundByOrderId.set(orderId, Math.max(refundByOrderId.get(orderId) || 0, cancellationRefund(item)));
    }
    const order = orderById.get(orderId);
    const fallbackCancelledAt = timestampMillis(latestTimestamp(item.update_time, item.create_time));
    incidents.push({ id: String(item.cancel_id || orderId), orderId, rmaId: String(item.cancel_id || ''), type: 'Hủy đơn',
      group: role === 'SYSTEM' ? 'SYSTEM · Tự động hủy do sự cố logistics' : role,
      reason, status: String(item.cancel_status || ''), actionCode: '', shippingReadyAt: 0,
      cancelledAt: timestampMillis(order?.cancel_time) || fallbackCancelledAt, updatedAt: fallbackCancelledAt });
  }

  for (const item of returns) {
    const orderId = String(item.order_id || '');
    const type = String(item.return_type || 'OTHER').toUpperCase();
    returnTypes[type] = (returnTypes[type] || 0) + 1;
    const reason = String(item.return_reason_text || item.return_reason || 'Không xác định');
    addCount(returnReasons, reason);
    if (orderId) {
      atRiskOrderIds.add(orderId);
      refundByOrderId.set(orderId, Math.max(refundByOrderId.get(orderId) || 0, returnRefund(item)));
    }
    incidents.push({ id: String(item.return_id || orderId), orderId, rmaId: String(item.return_id || ''), type: type === 'REFUND' ? 'Hoàn tiền' : 'Trả hàng',
      group: String(item.role || 'BUYER'), reason, status: String(item.return_status || ''), actionCode: '',
      shippingReadyAt: 0, cancelledAt: 0, updatedAt: timestampMillis(latestTimestamp(item.update_time, item.create_time)) });
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
    const shippingReadyAt = numberValue(events.find((event) => String(event.action_code || '') === '20101')?.update_time_millis);
    const periodEvents = events.filter((event) => {
      const timestamp = numberValue(event.update_time_millis);
      return timestamp >= rangeStart && timestamp < rangeEnd;
    });
    const failedEvents = periodEvents.filter((event) => DELIVERY_FAILURE_CODES.has(String(event.action_code || '')));
    const latestAll = events.at(-1);
    const returning = events.filter((event) => String(event.action_code || '') === '70201').at(-1);
    const alertIncident = { id: orderId, orderId, rmaId: '', type: 'Giao thất bại', group: 'LOGISTICS',
      reason: latestAll ? failedReason(latestAll) : 'Sự cố logistics',
      status: String(latestAll?.action_code_name || ACTION_LABELS[String(latestAll?.action_code || '')] || ''),
      actionCode: String(latestAll?.action_code || ''), shippingReadyAt, cancelledAt: 0,
      updatedAt: numberValue(latestAll?.update_time_millis) };
    if (returning && !Array.from(RECEIVED_CODES).some((code) => codes.has(code))) {
      const ageDays = Math.floor((Date.now() - numberValue(returning.update_time_millis)) / 86400000);
      if (ageDays > STUCK_RETURN_DAYS) stuckReturns.push({ ...alertIncident, ageDays });
    }
    if (codes.has('70301')) returnFailures.push(alertIncident);
    const currentCode = String(latestAll?.action_code || '');
    if (DELIVERY_FAILURE_CODES.has(currentCode) || ['70201', '70301', '70401', '70501'].includes(currentCode)) {
      atRiskOrderIds.add(orderId);
    }
    if (!failedEvents.length) continue;
    failedDeliveries += 1;
    const latest = failedEvents.at(-1)!;
    const currentEvent = latestAll || latest;
    const reason = failedReason(latest);
    addCount(failedReasons, reason);
    const incident = { id: orderId, orderId, rmaId: '', type: 'Giao thất bại', group: 'LOGISTICS', reason,
      status: String(currentEvent.action_code_name || ACTION_LABELS[String(currentEvent.action_code || '')] || ''),
      actionCode: String(currentEvent.action_code || ''), shippingReadyAt, cancelledAt: 0,
      updatedAt: numberValue(latest.update_time_millis) };
    incidents.push(incident);

  }

  let atRiskValue = 0;
  for (const orderId of atRiskOrderIds) {
    atRiskValue += refundByOrderId.get(orderId) || orderAmount(orderById.get(orderId));
  }
  incidents.sort((left, right) => numberValue(right.updatedAt) - numberValue(left.updatedAt));

  const totalOrders = populationOrders.length;
  const result = {
    generatedAt: new Date().toISOString(), startDate: input.startDate, endDate: input.endDate,
    shop: { name: shop.name || shop.shop_name, code: shop.code || shop.shop_code }, warnings,
    totals: {
      totalOrders,
      populationStart,
      openOrders: openOrders.length,
      cancellations: cancellations.length,
      cancellationRate: openOrders.length ? cancellations.length / openOrders.length : 0,
      cancellationRoles,
      returns: returns.length,
      returnEligibleOrders: deliveredOrders.length,
      returnRate: deliveredOrders.length ? returns.length / deliveredOrders.length : 0,
      returnTypes,
      dispatchedOrders: deliveryPopulation.length,
      deliveryPopulationOrders: deliveryPopulation.length,
      trackingCandidates: trackingCandidates.length,
      failedDeliveries,
      failedDeliveryRate: deliveryPopulation.length ? failedDeliveries / deliveryPopulation.length : 0,
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
