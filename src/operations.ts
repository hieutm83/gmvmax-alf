import type { Env } from './types';
import { authorizedShop, epoch, ordersForPeriod, ordersUpdatedForPeriod, shopRequest } from './seller';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

const TRACKING_RETRY_DELAYS = [2000, 5000, 10000];
const OPEN_ORDER_STATUSES = new Set(['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT']);
const CANCELLATION_STATUS_LABELS: Record<string, string> = {
  CANCELLATION_REQUEST_PENDING: 'Đang chờ duyệt huỷ',
  CANCELLATION_REQUEST_SUCCESS: 'Đã duyệt huỷ',
  CANCELLATION_REQUEST_CANCEL: 'Yêu cầu huỷ đã bị huỷ bỏ',
  CANCELLATION_REQUEST_CANCELLED: 'Yêu cầu huỷ đã bị huỷ bỏ',
  CANCELLATION_REQUEST_COMPLETE: 'Đã hoàn tất huỷ đơn'
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderAmount(order: any): number {
  const value = order?.order_amount ?? order?.payment?.total_amount ??
    order?.payment?.original_total_product_price ?? order?.total_amount;
  return numberValue(value?.amount ?? value?.value ?? value);
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
      update_time_ge: epoch(startDate),
      update_time_lt: epoch(shiftDate(endDate, 1)),
      locale: 'vi-VN'
    });
    rows.push(...(Array.isArray(data?.[listKey]) ? data[listKey] : []));
    pageToken = String(data?.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);
  return rows;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRateLimit(error: unknown): boolean {
  return /too many requests|rate limit|429/i.test(errorMessage(error));
}

async function enqueueTrackingRetry(env: Env, orderId: string, shopCipher: string): Promise<void> {
  const key = stableKey('tracking-retry-queued', { orderId, shopCipher });
  if (await cacheGet(env, key)) return;
  await env.TRACKING_QUEUE.send({ type: 'tracking-sync', orderId, shopCipher }, { delaySeconds: 60 });
  await cachePut(env, key, true, 300);
}

async function trackingForOrder(env: Env, orderId: string, shopCipher: string, queueOnRateLimit = true): Promise<any> {
  const key = stableKey('shop-tracking-v2', { orderId, shopCipher });
  const cached = await cacheGet<any>(env, key);
  if (cached) return { ...cached, cacheHit: true };
  let data: any;
  for (let attempt = 0; attempt <= TRACKING_RETRY_DELAYS.length; attempt += 1) {
    try {
      data = await shopRequest(env, `/logistics/202604/orders/${orderId}/tracking`, 'GET', { shop_cipher: shopCipher });
      break;
    } catch (error) {
      if (/11007009|not in supported business scenes|not in supported scope/i.test(errorMessage(error))) {
        data = { order_id: orderId, logistics_details: [], unsupported: true };
        break;
      }
      if (!isRateLimit(error)) throw error;
      if (attempt < TRACKING_RETRY_DELAYS.length) {
        await sleep(TRACKING_RETRY_DELAYS[attempt]);
        continue;
      }
      if (!queueOnRateLimit) throw new Error('TRACKING_RATE_LIMIT');
      await enqueueTrackingRetry(env, orderId, shopCipher);
      return { order_id: orderId, logistics_details: [], rateLimited: true };
    }
  }
  await cachePut(env, key, data, 900);
  return data;
}

export async function syncTrackingOrder(env: Env, orderId: string, shopCipher: string): Promise<void> {
  await trackingForOrder(env, orderId, shopCipher, false);
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

function isLogisticsCancellation(item: any): boolean {
  const role = String(item?.role || '').toUpperCase();
  const reason = `${item?.cancel_reason_text || ''} ${item?.cancel_reason || ''}`;
  return role === 'SYSTEM' && /giao gói hàng thất bại|package delivery failed|delivery fail/i.test(reason);
}

function addCount(map: Map<string, number>, label: string): void {
  const key = label || 'Không xác định';
  map.set(key, (map.get(key) || 0) + 1);
}

function breakdown(map: Map<string, number>): Array<{ label: string; count: number }> {
  return Array.from(map, ([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count);
}

export function returnReasonLabel(item: any): string {
  // Search Returns documents these fields on each return_orders item. Prefer the
  // stable code because TikTok occasionally returns an unrelated localized text.
  const rawCode = item?.return_reason?.code || item?.return_reason || item?.refund_reason?.code || item?.refund_reason;
  const rawText = item?.return_reason_text || item?.return_reason?.text ||
    item?.refund_reason_text || item?.refund_reason?.text;
  const code = String(rawCode || '').toLowerCase();
  const mappings: Array<[RegExp, string]> = [
    [/suspected_counterfeit/, 'Nghi ngờ hàng giả'],
    [/not_match(?:_description)?/, 'Sản phẩm không khớp với mô tả'],
    [/wrong_product/, 'Gửi sai sản phẩm'],
    [/missing_(?:product|parts|broken_parts)/, 'Thiếu sản phẩm hoặc phụ kiện'],
    [/damaged/, 'Sản phẩm hoặc bao bì bị hư hỏng'],
    [/defective/, 'Sản phẩm bị lỗi hoặc không hoạt động'],
    [/not_received/, 'Chưa nhận được hàng'],
    [/(?:missed_delivery|not_arrive_on_time)/, 'Giao hàng trễ'],
    [/no_need/, 'Không còn nhu cầu'],
    [/_other(?:_|$)/, 'Lý do khác']
  ];
  for (const [pattern, label] of mappings) if (pattern.test(code)) return label;
  return String(rawText || rawCode || 'Không xác định');
}

async function currentLifecycleCounts(env: Env, shopCipher: string,
  lifecycle: Array<{ code: string; label: string }>, warnings: string[]): Promise<Map<string, number>> {
  const counts = new Map(lifecycle.map((item) => [item.code, 0]));
  for (const item of lifecycle) {
    try {
      const data = await shopRequest(env, '/order/202309/orders/search', 'POST', {
        shop_cipher: shopCipher,
        page_size: 1,
        sort_field: 'update_time',
        sort_order: 'DESC'
      }, { order_status: item.code });
      counts.set(item.code, numberValue(data?.total_count ?? data?.orders?.length));
    } catch (error) {
      warnings.push(`Phễu ${item.label}: ${errorMessage(error)}`);
    }
  }
  return counts;
}

function latestTimestamp(...values: unknown[]): number {
  return Math.max(0, ...values.map(numberValue));
}

function timestampMillis(value: unknown): number {
  const timestamp = numberValue(value);
  return timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function orderTimestamp(order: any, field: 'collection_time' | 'delivery_time'): number {
  const packages = Array.isArray(order?.packages) ? order.packages : [];
  return timestampMillis(latestTimestamp(order?.[field], ...packages.map((item: any) => item?.[field])));
}

function packageStatus(order: any): string {
  const packages = Array.isArray(order?.packages) ? order.packages : [];
  return [order?.package_status, ...packages.map((item: any) => item?.status || item?.package_status)]
    .map((value) => String(value || '').toUpperCase()).find(Boolean) || '';
}

function orderSellerSkus(order: any): string[] {
  const items = Array.isArray(order?.line_items) ? order.line_items : Array.isArray(order?.items) ? order.items : [];
  return Array.from(new Set(items.map((item: any) => String(
    item?.seller_sku || item?.sku_name || item?.sku_id || ''
  ).trim()).filter(Boolean)));
}

const VIETNAM_PROVINCES = [
  'An Giang', 'Bà Rịa - Vũng Tàu', 'Bắc Giang', 'Bắc Kạn', 'Bạc Liêu', 'Bắc Ninh',
  'Bến Tre', 'Bình Định', 'Bình Dương', 'Bình Phước', 'Bình Thuận', 'Cà Mau',
  'Cần Thơ', 'Cao Bằng', 'Đà Nẵng', 'Đắk Lắk', 'Đắk Nông', 'Điện Biên', 'Đồng Nai',
  'Đồng Tháp', 'Gia Lai', 'Hà Giang', 'Hà Nam', 'Hà Nội', 'Hà Tĩnh', 'Hải Dương',
  'Hải Phòng', 'Hậu Giang', 'Hòa Bình', 'Hồ Chí Minh', 'Hưng Yên', 'Khánh Hòa',
  'Kiên Giang', 'Kon Tum', 'Lai Châu', 'Lâm Đồng', 'Lạng Sơn', 'Lào Cai', 'Long An',
  'Nam Định', 'Nghệ An', 'Ninh Bình', 'Ninh Thuận', 'Phú Thọ', 'Phú Yên',
  'Quảng Bình', 'Quảng Nam', 'Quảng Ngãi', 'Quảng Ninh', 'Quảng Trị', 'Sóc Trăng',
  'Sơn La', 'Tây Ninh', 'Thái Bình', 'Thái Nguyên', 'Thanh Hóa', 'Thừa Thiên Huế',
  'Tiền Giang', 'Trà Vinh', 'Tuyên Quang', 'Vĩnh Long', 'Vĩnh Phúc', 'Yên Bái', 'Huế'
] as const;

function normalizedAddress(value: unknown): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function provinceFromAddressText(value: unknown): string {
  const normalized = ` ${normalizedAddress(value)} `;
  if (!normalized.trim()) return '';
  for (const province of VIETNAM_PROVINCES) {
    if (normalized.includes(` ${normalizedAddress(province)} `)) return province;
  }
  return '';
}

function asAddressObject(value: any): any {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { return value.trim() ? { full_address: value } : {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function recipientAddress(order: any): any {
  const candidates = [
    order?.recipient_address,
    order?.shipping_address,
    order?.delivery_address,
    order?.receiver_address,
    order?.address,
    order?.shipping_info?.recipient_address
  ].map(asAddressObject);
  return candidates.find((candidate) => Object.entries(candidate).some(([key, value]) =>
    value !== undefined && value !== null && String(value).trim() !== '' &&
    !['district_info', 'district_info_list', 'district_infos'].includes(key))) ||
    candidates.find((candidate) => Object.keys(candidate).length > 0) || {};
}

function recipientDistricts(order: any): any[] {
  const address = recipientAddress(order);
  let regions = address.district_info || address.district_info_list || address.district_infos || [];
  if (typeof regions === 'string') {
    try { regions = JSON.parse(regions); } catch { regions = []; }
  }
  if (Array.isArray(regions)) return regions;
  return regions && typeof regions === 'object' ? Object.values(regions) : [];
}

function hasRecipientProvince(order: any): boolean {
  const address = recipientAddress(order);
  return Boolean(address.state || address.province || address.region_name ||
    provinceFromAddressText(address.full_address || address.address_detail) || recipientDistricts(order).some((item: any) =>
    /^(L1|LEVEL_1)$/i.test(String(item?.address_level || item?.level || '')) ||
    /PROVINCE|STATE|TINH|THANH PHO|TỈNH|THÀNH PHỐ/i.test(String(item?.address_level_name || item?.address_type || ''))
  ));
}

export function orderProvince(order: any): string {
  const address = recipientAddress(order);
  const regions = recipientDistricts(order);
  const province = regions.find((item: any) => /^(L1|LEVEL_1)$/i.test(String(item?.address_level || item?.level || ''))) ||
    regions.find((item: any) => /PROVINCE|STATE|TINH|THANH PHO|TỈNH|THÀNH PHỐ/i.test(String(item?.address_level_name || item?.address_type || ''))) ||
    regions.find((item: any) => !/^L0$/i.test(String(item?.address_level || item?.level || ''))) || regions[0];
  return String(province?.address_name || province?.name || province?.region_name ||
    address.state || address.province || address.region_name ||
    provinceFromAddressText(order?.province || order?.province_name || order?.region || order?.region_name) ||
    provinceFromAddressText(address.full_address || address.address_detail ||
      [address.address_line1, address.address_line2, address.address_line3, address.address_line4].filter(Boolean).join(', ')) ||
    'Không xác định');
}

function mergeOrderRecord(current: any, incoming: any): any {
  const currentAddress = recipientAddress(current);
  const incomingAddress = recipientAddress(incoming);
  const merged = { ...(current || {}), ...(incoming || {}) };
  if (Object.keys(currentAddress).length || Object.keys(incomingAddress).length) {
    merged.recipient_address = { ...currentAddress, ...incomingAddress };
    const districts = recipientDistricts(incoming).length ? recipientDistricts(incoming) : recipientDistricts(current);
    if (districts.length) merged.recipient_address.district_info = districts;
  }
  return merged;
}

export function calculateCancellationRate(cancellations: unknown, totalOrders: unknown): number {
  const total = numberValue(totalOrders);
  return total > 0 ? numberValue(cancellations) / total : 0;
}

export async function loadOperationsAnalysis(env: Env, input: any): Promise<any> {
  const key = stableKey('seller-operations-v11-comparison-breakdowns', { startDate: input.startDate, endDate: input.endDate, skipComparison: input.skipComparison === true });
  const cached = input.forceRefresh === true ? null : await cacheGet<any>(env, key);
  if (cached) return cached;

  const shop = await authorizedShop(env);
  if (!shop) throw new Error('Seller OAuth chưa trả về TikTok Shop được ủy quyền.');
  const cipher = String(shop.cipher || shop.shop_cipher || shop.id || '');
  if (!cipher) throw new Error('Không tìm thấy shop_cipher.');

  const warnings: string[] = [];
  const populationStart = input.startDate;
  const [populationOrders, updatedOrders] = await Promise.all([
    ordersForPeriod(env, populationStart, input.endDate, cipher),
    ordersUpdatedForPeriod(env, input.startDate, input.endDate, cipher)
  ]);
  const orderById = new Map(populationOrders.map((order) => [String(order.id || order.order_id || ''), order]));
  updatedOrders.forEach((order) => {
    const id = String(order.id || order.order_id || '');
    orderById.set(id, mergeOrderRecord(orderById.get(id), order));
  });

  const [cancellations, returns] = await Promise.all([
    pagedSearch(env, '/return_refund/202602/cancellations/search', 'cancellations', cipher, input.startDate, input.endDate)
      .catch((error) => { warnings.push(`Hủy đơn: ${errorMessage(error)}`); return []; }),
    pagedSearch(env, '/return_refund/202602/returns/search', 'return_orders', cipher, input.startDate, input.endDate)
      .catch((error) => { warnings.push(`Trả hàng/hoàn tiền: ${errorMessage(error)}`); return []; })
  ]);

  const eventOrderIds = Array.from(new Set([...cancellations, ...returns]
    .map((item) => String(item.order_id || '')).filter(Boolean)));
  // List results may omit recipient_address even when the order exists. Fetch
  // details for incomplete event rows so alerts match the Seller Center data.
  const detailOrderIds = eventOrderIds.filter((id) => {
    const order = orderById.get(id);
    return !order || !hasRecipientProvince(order);
  });
  if (detailOrderIds.length) {
    try {
      for (const detail of await orderDetails(env, detailOrderIds, cipher)) {
        const id = String(detail.id || detail.order_id || '');
        orderById.set(id, mergeOrderRecord(orderById.get(id), detail));
      }
    } catch (error) {
      warnings.push(`Chi tiết đơn hàng: ${errorMessage(error)}`);
    }
  }

  const rangeStart = epoch(input.startDate) * 1000;
  const rangeEnd = epoch(shiftDate(input.endDate, 1)) * 1000;
  const openOrders = populationOrders.filter((order) => OPEN_ORDER_STATUSES.has(String(order.status || '').toUpperCase()));
  const deliveredOrders = populationOrders.filter((order) => String(order.status || '').toUpperCase() === 'DELIVERED');
  const cancellationsCreatedInRange = cancellations.filter((item) => {
    const order = orderById.get(String(item.order_id || ''));
    const createdAt = timestampMillis(order?.create_time);
    return createdAt >= rangeStart && createdAt < rangeEnd;
  });
  const cancellationKpiSet = new Set(cancellationsCreatedInRange);
  const systemCancellations = cancellations.filter((item) => String(item.role || '').toUpperCase() === 'SYSTEM');
  const logisticsCancellations = systemCancellations.filter(isLogisticsCancellation);

  const cancellationRoles = { BUYER: 0, SYSTEM: 0, SELLER: 0 };
  const returnTypes: Record<string, number> = { REFUND: 0, RETURN_AND_REFUND: 0 };
  const cancelReasons = new Map<string, number>();
  const returnReasons = new Map<string, number>();
  const systemCancelReasons = new Map<string, number>();
  const incidents: any[] = [];

  for (const item of cancellations) {
    const orderId = String(item.order_id || '');
    const role = String(item.role || 'SYSTEM').toUpperCase();
    if (cancellationKpiSet.has(item) && role in cancellationRoles) {
      cancellationRoles[role as keyof typeof cancellationRoles] += 1;
    }
    const reason = String(item.cancel_reason_text || item.cancel_reason || 'Không xác định');
    addCount(cancelReasons, reason);
    if (role === 'SYSTEM') addCount(systemCancelReasons, reason);
    const order = orderById.get(orderId);
    const fallbackCancelledAt = timestampMillis(latestTimestamp(item.update_time, item.create_time));
    // The cancellation search response only contains the request/update times.
    // Get Order Detail carries the rest of the Seller Center timeline, including
    // payment, ready-to-ship, request-cancel and final cancel timestamps.
    const cancellationRequestedAt = timestampMillis(item.create_time) ||
      timestampMillis(order?.request_cancel_time) || fallbackCancelledAt;
    const cancelStatus = String(item.cancel_status || '').toUpperCase();
    // For a completed buyer cancellation, the order's cancel_time is the
    // platform approval/status transition while the cancellation record's
    // update_time is the later refund-completion event.
    const cancellationApprovedAt = cancelStatus === 'CANCELLATION_REQUEST_COMPLETE'
      ? timestampMillis(order?.cancel_time) || timestampMillis(item.update_time) || fallbackCancelledAt
      : timestampMillis(item.update_time) || fallbackCancelledAt;
    const paidAt = timestampMillis(order?.paid_time || order?.payment?.paid_time || order?.payment?.payment_time);
    const readyToShipAt = timestampMillis(order?.rts_time);
    const refundCompletedAt = cancelStatus === 'CANCELLATION_REQUEST_COMPLETE'
      ? timestampMillis(item.update_time) || timestampMillis(order?.cancel_time) || fallbackCancelledAt : 0;
    incidents.push({ id: String(item.cancel_id || orderId), orderId, rmaId: String(item.cancel_id || ''), type: 'Hủy đơn',
      group: role,
      reason, status: CANCELLATION_STATUS_LABELS[cancelStatus] || cancelStatus, actionCode: '',
      sellerSkus: orderSellerSkus(order), province: orderProvince(order),
      collectionTime: orderTimestamp(order, 'collection_time'), deliveryTime: orderTimestamp(order, 'delivery_time'),
      packageStatus: packageStatus(order),
      cancelledAt: refundCompletedAt || timestampMillis(order?.cancel_time) || cancellationApprovedAt,
      orderHistory: {
        cancellationRequestedAt,
        cancellationApprovedAt,
        refundCompletedAt,
        paidAt,
        readyToShipAt,
        orderCreatedAt: timestampMillis(order?.create_time)
      } });
  }

  for (const item of returns) {
    const orderId = String(item.order_id || '');
    const type = String(item.return_type || 'OTHER').toUpperCase();
    returnTypes[type] = (returnTypes[type] || 0) + 1;
    const reason = returnReasonLabel(item);
    addCount(returnReasons, reason);
    const order = orderById.get(orderId);
    incidents.push({ id: String(item.return_id || orderId), orderId, rmaId: String(item.return_id || ''), type: type === 'REFUND' ? 'Hoàn tiền' : 'Trả hàng',
      group: String(item.role || 'BUYER'), reason, status: String(item.return_status || ''), actionCode: '',
      collectionTime: orderTimestamp(order, 'collection_time'), deliveryTime: orderTimestamp(order, 'delivery_time'),
      packageStatus: packageStatus(order), cancelledAt: 0, updatedAt: timestampMillis(latestTimestamp(item.update_time, item.create_time)) });
  }

  const currentLifecycle = [
    { code: 'UNPAID', label: 'Chưa thanh toán' },
    { code: 'AWAITING_SHIPMENT', label: 'Chờ vận chuyển' },
    { code: 'AWAITING_COLLECTION', label: 'Chờ thu gom' },
    { code: 'IN_TRANSIT', label: 'Đang vận chuyển' }
  ];
  const lifecycleCounts = await currentLifecycleCounts(env, cipher, currentLifecycle, warnings);
  const funnel = [
    ...currentLifecycle.map((item) => ({ ...item, count: lifecycleCounts.get(item.code) || 0 })),
    { code: 'CANCELLED_IN_PERIOD', label: 'Đã hủy', count: cancellations.length },
    { code: 'REFUND_IN_PERIOD', label: 'Hoàn tiền', count: returns.length }
  ];

  const logisticsCancellationByOrderId = new Map(logisticsCancellations
    .map((item) => [String(item.order_id || ''), item] as const).filter(([orderId]) => Boolean(orderId)));
  const logisticsOrderIds = new Set(logisticsCancellationByOrderId.keys());
  let atRiskValue = 0;
  for (const orderId of logisticsOrderIds) {
    atRiskValue += orderAmount(orderById.get(orderId)) || orderAmount(logisticsCancellationByOrderId.get(orderId));
  }
  incidents.sort((left, right) => numberValue(right.updatedAt) - numberValue(left.updatedAt));

  const totalOrders = populationOrders.length;
  const days = Math.max(1, Math.floor((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1);
  const previousEndDate = shiftDate(input.startDate, -1);
  const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const previous = input.skipComparison === true ? null : await loadOperationsAnalysis(env, {
    startDate: previousStartDate, endDate: previousEndDate, forceRefresh: input.forceRefresh === true, skipComparison: true
  }).catch((error) => { warnings.push(`Kỳ trước: ${errorMessage(error)}`); return null; });
  const result = {
    schemaVersion: 'operations-v11-comparison-breakdowns',
    generatedAt: new Date().toISOString(), startDate: input.startDate, endDate: input.endDate,
    shop: { name: shop.name || shop.shop_name, code: shop.code || shop.shop_code }, warnings,
    totals: {
      totalOrders,
      populationStart,
      openOrders: openOrders.length,
      cancellations: cancellationsCreatedInRange.length,
      cancellationRate: calculateCancellationRate(cancellationsCreatedInRange.length, totalOrders),
      cancellationRoles,
      returns: returns.length,
      returnEligibleOrders: deliveredOrders.length,
      returnRate: deliveredOrders.length ? returns.length / deliveredOrders.length : 0,
      returnTypes,
      logisticsCancellations: logisticsOrderIds.size,
      logisticsCancellationRate: totalOrders ? logisticsOrderIds.size / totalOrders : 0,
      atRiskValue
    },
    cancelReasons: breakdown(cancelReasons),
    returnReasons: breakdown(returnReasons),
    failedReasons: breakdown(systemCancelReasons),
    funnel,
    incidents,
    previous: previous ? previous.totals : null,
    previousBreakdowns: previous ? {
      cancelReasons: previous.cancelReasons || [],
      returnReasons: previous.returnReasons || [],
      failedReasons: previous.failedReasons || []
    } : null,
    previousStartDate,
    previousEndDate
  };
  await cachePut(env, key, result, 300);
  return result;
}
