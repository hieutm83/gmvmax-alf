import type { Env } from './types';
import { authorizedShop, shopRequest } from './seller';
import { loadOperationsAnalysis } from './operations';
import { hourInTimezone } from './utils';

const API = 'https://bot-api.zaloplatforms.com/bot';
const RED = 'c_db342e';
const GREEN = 'c_15a85f';
const SEPARATOR = '-----------------------------------';
const STATUS_DEFINITIONS = [
  { code: 'AWAITING_SHIPMENT', label: 'Số đơn chờ vận chuyển' },
  { code: 'AWAITING_COLLECTION', label: 'Số đơn chờ thu gom' }
] as const;

export interface OrderBotSlot {
  time: string;
  cutoffTime: '00:01' | '18:00';
  oldLabel: 'Đơn cần gửi trước 12h' | 'Đơn cần gửi trước 19h';
}

export interface OrderSkuBreakdown { sellerSku: string; qty: number; orders: number; }
export interface OrderTextStyle { start: number; len: number; st: string[]; }
export interface OrderStatusSummary {
  label: string;
  total: number;
  oldTotal: number;
  newTotal: number;
  oldBreakdown: OrderSkuBreakdown[];
  newBreakdown: OrderSkuBreakdown[];
}

const BEFORE_NOON_SLOTS = ['07:56', '08:56', '09:56', '10:56', '11:56'];
const BEFORE_19H_SLOTS = ['14:56', '15:56', '16:56', '17:56', '18:56'];

export const ORDER_BOT_SLOTS: Record<string, OrderBotSlot> = Object.fromEntries([
  ...BEFORE_NOON_SLOTS, ...BEFORE_19H_SLOTS
].map((time) => [time, {
  time,
  cutoffTime: BEFORE_NOON_SLOTS.includes(time) ? '00:01' : '18:00',
  oldLabel: BEFORE_NOON_SLOTS.includes(time) ? 'Đơn cần gửi trước 12h' : 'Đơn cần gửi trước 19h'
}])) as Record<string, OrderBotSlot>;

export function isOrderBotReportDay(localDate: string): boolean {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay() !== 0;
}

function timestampMillis(value: unknown): number {
  const timestamp = Number(value) || 0;
  return timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

export function zonedDateTimeEpoch(localDate: string, localTime: string, timezone: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const representedUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const correction = desiredUtc - representedUtc;
    candidate += correction;
    if (!correction) break;
  }
  return candidate;
}

function orderItems(order: any): any[] {
  const direct = Array.isArray(order?.line_items) ? order.line_items : Array.isArray(order?.items) ? order.items : [];
  return direct;
}

function itemSku(item: any): string {
  return String(item?.seller_sku || item?.sku_name || item?.sku_id || 'Không xác định').trim() || 'Không xác định';
}

function itemQty(item: any): number {
  return Math.max(1, Math.round(Number(item?.quantity ?? item?.qty ?? item?.sku_quantity ?? 1) || 1));
}

export function summarizeOrderStatus(label: string, orders: any[], cutoffEpoch: number): OrderStatusSummary {
  const oldOrders = orders.filter((order) => timestampMillis(order?.create_time) < cutoffEpoch);
  const newOrders = orders.filter((order) => timestampMillis(order?.create_time) >= cutoffEpoch);
  const summarize = (source: any[]): OrderSkuBreakdown[] => {
    const counts = new Map<string, { sellerSku: string; qty: number; orderIds: Set<string> }>();
    source.forEach((order, orderIndex) => {
      const orderId = String(order?.id || order?.order_id || orderIndex);
      const seen = new Set<string>();
      for (const item of orderItems(order)) {
        const sellerSku = itemSku(item);
        const qty = itemQty(item);
        const key = `${sellerSku}\u0000${qty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!counts.has(key)) counts.set(key, { sellerSku, qty, orderIds: new Set() });
        counts.get(key)!.orderIds.add(orderId);
      }
    });
    const skuTotals = new Map<string, Set<string>>();
    for (const value of counts.values()) {
      if (!skuTotals.has(value.sellerSku)) skuTotals.set(value.sellerSku, new Set());
      value.orderIds.forEach((id) => skuTotals.get(value.sellerSku)!.add(id));
    }
    return Array.from(counts.values()).map((value) => ({ sellerSku: value.sellerSku, qty: value.qty, orders: value.orderIds.size }))
      .sort((left, right) => (skuTotals.get(right.sellerSku)?.size || 0) - (skuTotals.get(left.sellerSku)?.size || 0)
        || left.sellerSku.localeCompare(right.sellerSku, 'vi') || left.qty - right.qty);
  };
  return {
    label, total: orders.length, oldTotal: oldOrders.length, newTotal: newOrders.length,
    oldBreakdown: summarize(oldOrders), newBreakdown: summarize(newOrders)
  };
}

export function formatOrderBotReport(localDate: string, slot: OrderBotSlot, summaries: OrderStatusSummary[], updatedAt: Date,
  timezone: string, maxBreakdownLines = Number.POSITIVE_INFINITY): string {
  const updatedTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(updatedAt);
  const lines = [
    `Báo cáo vận đơn TikTok Shop ${localDate.split('-').reverse().join('/')}`,
    `Cập nhật: ${updatedTime}`
  ];
  summaries.forEach((summary) => {
    lines.push(SEPARATOR);
    lines.push(`${summary.label}: ${summary.total} đơn`);
    if (summary.total > 0) {
      lines.push(`${slot.oldLabel}: ${summary.oldTotal} đơn`);
      summary.oldBreakdown.slice(0, maxBreakdownLines).forEach((row) => lines.push(`- ${row.sellerSku}: ${row.orders} đơn`));
      if (summary.oldBreakdown.length > maxBreakdownLines) {
        const remaining = new Set(summary.oldBreakdown.slice(maxBreakdownLines).map((row) => row.sellerSku)).size;
        lines.push(`... và ${remaining} SKU khác`);
      }
      lines.push(`Đơn mới: ${summary.newTotal} đơn`);
      summary.newBreakdown.slice(0, maxBreakdownLines).forEach((row) => lines.push(`- ${row.sellerSku}: ${row.orders} đơn`));
      if (summary.newBreakdown.length > maxBreakdownLines) {
        const remaining = new Set(summary.newBreakdown.slice(maxBreakdownLines).map((row) => row.sellerSku)).size;
        lines.push(`... và ${remaining} SKU khác`);
      }
    }
  });
  lines.push(SEPARATOR);
  return lines.join('\n');
}

export function buildOrderBotStyles(text: string): OrderTextStyle[] {
  const styles: OrderTextStyle[] = [];
  const add = (start: number, len: number, ...st: string[]) => {
    if (start >= 0 && len > 0) styles.push({ start, len, st });
  };
  const lines = text.split('\n');
  const titleEnd = text.indexOf('\n');
  if (titleEnd >= 0 && titleEnd + 1 < text.length) add(titleEnd + 1, text.length - titleEnd - 1, 'f_13');
  let offset = 0;
  for (const line of lines) {
    if (/^Đơn cần gửi trước/.test(line)) {
      add(offset, line.length, 'f_13', 'i');
      const labelEnd = line.indexOf(':') + 1;
      if (labelEnd > 0) add(offset, labelEnd, 'u', GREEN);
      const groupTotal = line.match(/(\d+\s+đơn)$/);
      if (groupTotal) add(offset + line.lastIndexOf(groupTotal[1]), groupTotal[1].length, RED);
    } else if (/^Đơn mới:/.test(line)) {
      add(offset, line.length, 'f_13', 'i');
      const labelEnd = line.indexOf(':') + 1;
      if (labelEnd > 0) add(offset, labelEnd, 'u', GREEN);
      const groupTotal = line.match(/(\d+\s+đơn)$/);
      if (groupTotal) add(offset + line.lastIndexOf(groupTotal[1]), groupTotal[1].length, RED);
    }
    const totalMatch = line.match(/^Số đơn .+?:\s*(\d+\s+đơn)$/);
    if (totalMatch) add(offset + line.lastIndexOf(totalMatch[1]), totalMatch[1].length, 'b', RED);
    const breakdownMatch = line.match(/^-.+?:\s*(\d+\s+đơn)$/);
    if (breakdownMatch) {
      add(offset, line.length, 'f_13');
      add(offset + line.lastIndexOf(breakdownMatch[1]), breakdownMatch[1].length, 'b');
    }
    offset += line.length + 1;
  }
  return styles;
}

async function currentOrders(env: Env, shopCipher: string, status: string): Promise<any[]> {
  const rows: any[] = [];
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env, '/order/202309/orders/search', 'POST', {
      shop_cipher: shopCipher, page_size: 100, page_token: pageToken || undefined,
      sort_field: 'create_time', sort_order: 'ASC'
    }, { order_status: status });
    rows.push(...(Array.isArray(data?.orders) ? data.orders : []));
    pageToken = String(data?.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);

  const detailsById = new Map<string, any>();
  for (let offset = 0; offset < rows.length; offset += 50) {
    const ids = rows.slice(offset, offset + 50).map((order) => String(order.id || order.order_id || '')).filter(Boolean);
    if (!ids.length) continue;
    const data = await shopRequest(env, '/order/202507/orders', 'GET', { shop_cipher: shopCipher, ids: ids.join(',') });
    for (const order of (Array.isArray(data?.orders) ? data.orders : [])) {
      detailsById.set(String(order.id || order.order_id || ''), order);
    }
  }
  return rows.map((order) => detailsById.get(String(order.id || order.order_id || '')) || order);
}

async function sendOrderBotMessage(env: Env, text: string, styles = buildOrderBotStyles(text)): Promise<string> {
  if (!env.ZALO_ORDER_BOT_TOKEN) throw new Error('Missing ZALO_ORDER_BOT_TOKEN.');
  if (!env.ZALO_ORDER_GROUP_CHAT_ID) throw new Error('Missing ZALO_ORDER_GROUP_CHAT_ID.');
  const response = await fetch(`${API}${encodeURIComponent(env.ZALO_ORDER_BOT_TOKEN)}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: env.ZALO_ORDER_GROUP_CHAT_ID, text, text_styles: styles })
  });
  const data = await response.json<any>().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error(`Zalo Bot API ${data.error_code || response.status}: ${data.description || 'Invalid response'}`);
  return String(data.result?.message_id || '');
}

export function formatCancellationAlert(incident: any, timezone: string): { text: string; styles: OrderTextStyle[] } {
  const cancelledAt = timestampMillis(incident?.cancelledAt || incident?.updatedAt);
  const formatTime = (value: unknown): string => {
    const timestamp = timestampMillis(value);
    return timestamp ? new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(timestamp)).replace(',', '') : 'Không xác định';
  };
  const history = incident?.orderHistory || {};
  const requestedAt = history.cancellationRequestedAt || cancelledAt;
  const approvedAt = history.cancellationApprovedAt || cancelledAt;
  const refundCompletedAt = timestampMillis(history.refundCompletedAt);
  const paidAt = timestampMillis(history.paidAt);
  const readyToShipAt = timestampMillis(history.readyToShipAt);
  const orderCreatedAt = history.orderCreatedAt;
  const initiator = String(incident?.group || '').toUpperCase();
  const requestLabel = initiator === 'SELLER'
    ? 'Yêu cầu hủy được gửi bởi nhà bán hàng'
    : initiator === 'SYSTEM' || initiator === 'OPERATOR'
      ? 'Yêu cầu hủy được tạo bởi TikTok Shop'
      : 'Yêu cầu hủy được gửi bởi khách hàng';
  const historyLines: string[] = [];
  if (refundCompletedAt) {
    historyLines.push('• Hoàn tất hoàn tiền', `  ${formatTime(refundCompletedAt)}`);
  }
  historyLines.push(
    `• ${requestLabel}`,
    `  ${String(incident?.reason || 'Không xác định')}`,
    `  ${formatTime(requestedAt)}`,
    '• Được TikTok Shop tự động phê duyệt theo chính sách hiện hành',
    `  ${formatTime(approvedAt)}`
  );
  if (readyToShipAt) historyLines.push('• Đơn hàng sẵn sàng vận chuyển', `  ${formatTime(readyToShipAt)}`);
  if (paidAt) historyLines.push('• Đơn hàng đã thanh toán', `  ${formatTime(paidAt)}`);
  historyLines.push('• Đơn hàng do khách hàng tạo', `  ${formatTime(orderCreatedAt)}`);
  const text = [
    'Đơn hủy',
    `Mã đơn: ${String(incident?.orderId || '')}`,
    `Loại sự cố: ${String(incident?.type || 'Hủy đơn')}`,
    `Nhóm / Khởi tạo: ${String(incident?.group || 'Không xác định')}`,
    `Lý do chi tiết: ${String(incident?.reason || 'Không xác định')}`,
    'Lịch sử đơn hàng',
    ...historyLines
  ].join('\n');
  const titleLength = 'Đơn hủy'.length;
  const styles: OrderTextStyle[] = [
    { start: 0, len: titleLength, st: ['f_15', 'u', 'i', RED] },
    { start: titleLength + 1, len: text.length - titleLength - 1, st: ['f_13'] }
  ];
  let offset = 0;
  for (const line of text.split('\n')) {
    const topLabel = line.match(/^(Mã đơn|Loại sự cố|Nhóm \/ Khởi tạo|Lý do chi tiết):/);
    if (topLabel) styles.push({ start: offset, len: topLabel[0].length, st: ['b'] });
    if (line === 'Lịch sử đơn hàng' || line.startsWith('• ')) styles.push({ start: offset, len: line.length, st: ['b'] });
    if (line.startsWith('  ')) {
      const detailStyles = ['f_13', 'i'];
      if (!/^\s+\d{2}\/\d{2}\/\d{4}\s/.test(line)) detailStyles.push(RED);
      styles.push({ start: offset, len: line.length, st: detailStyles });
    }
    offset += line.length + 1;
  }
  return { text, styles };
}

function cancellationId(incident: any): string {
  return String(incident?.rmaId || incident?.id || incident?.orderId || '');
}

async function sendCancellationIncident(env: Env, incident: any): Promise<string> {
  const formatted = formatCancellationAlert(incident, env.TIMEZONE || 'Asia/Bangkok');
  return sendOrderBotMessage(env, formatted.text, formatted.styles);
}

export async function monitorOrderBot(env: Env, reportDate: string): Promise<void> {
  if (!env.ZALO_ORDER_BOT_TOKEN || !env.ZALO_ORDER_GROUP_CHAT_ID) return;
  const analysis = await loadOperationsAnalysis(env, {
    startDate: reportDate, endDate: reportDate, forceRefresh: true, skipComparison: true
  });
  const counts = Object.fromEntries((analysis.funnel || []).map((item: any) => [String(item.code), Number(item.count) || 0]));
  const stateKey = `lifecycle:${reportDate}`;
  const previousRow = await env.DB.prepare('SELECT payload FROM order_bot_monitor_state WHERE state_key=?')
    .bind(stateKey).first<{ payload: string }>();
  const previous = previousRow ? JSON.parse(previousRow.payload) : null;
  const cancellations = (analysis.incidents || []).filter((incident: any) => String(incident.type).toLowerCase() === 'hủy đơn');

  if (!previous) {
    for (const incident of cancellations) {
      const id = cancellationId(incident); if (!id) continue;
      await env.DB.prepare(`INSERT OR IGNORE INTO order_bot_cancellation_events(cancellation_id,order_id,status,payload)
        VALUES(?,?,?,?)`).bind(id, String(incident.orderId || ''), 'SEEN', JSON.stringify(incident)).run();
    }
  } else {
    const movedToTransit = Number(counts.AWAITING_COLLECTION) < Number(previous.AWAITING_COLLECTION || 0) &&
      Number(counts.IN_TRANSIT) > Number(previous.IN_TRANSIT || 0);
    if (movedToTransit) {
      const hour = hourInTimezone(new Date(), env.TIMEZONE || 'Asia/Bangkok');
      await sendOrderBotReport(env, reportDate, hour < 14 ? '10:56' : '16:56', true);
    }
    for (const incident of cancellations.slice().sort((a: any, b: any) => timestampMillis(a.cancelledAt) - timestampMillis(b.cancelledAt))) {
      const id = cancellationId(incident); if (!id) continue;
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO order_bot_cancellation_events(cancellation_id,order_id,status,payload)
        VALUES(?,?,?,?)`).bind(id, String(incident.orderId || ''), 'PENDING', JSON.stringify(incident)).run();
      if (!inserted.meta.changes) continue;
      const messageId = await sendCancellationIncident(env, incident);
      await env.DB.prepare(`UPDATE order_bot_cancellation_events SET status='SENT',message_id=?,updated_at=CURRENT_TIMESTAMP
        WHERE cancellation_id=?`).bind(messageId, id).run();
    }
  }
  await env.DB.prepare(`INSERT INTO order_bot_monitor_state(state_key,payload) VALUES(?,?)
    ON CONFLICT(state_key) DO UPDATE SET payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(stateKey, JSON.stringify(counts)).run();
}

export async function sendLatestCancellationTest(env: Env, reportDate: string): Promise<{ id: string; messageId: string }> {
  const analysis = await loadOperationsAnalysis(env, {
    startDate: reportDate, endDate: reportDate, forceRefresh: true, skipComparison: true
  });
  const latest = (analysis.incidents || []).filter((incident: any) => String(incident.type).toLowerCase() === 'hủy đơn')
    .sort((a: any, b: any) => timestampMillis(b.cancelledAt) - timestampMillis(a.cancelledAt))[0];
  if (!latest) throw new Error(`Không có đơn hủy trong ngày ${reportDate}.`);
  const id = cancellationId(latest);
  const messageId = await sendCancellationIncident(env, latest);
  await env.DB.prepare(`INSERT INTO order_bot_cancellation_events(cancellation_id,order_id,status,message_id,payload)
    VALUES(?,?,?,?,?) ON CONFLICT(cancellation_id) DO UPDATE SET status=excluded.status,message_id=excluded.message_id,
    payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(id, String(latest.orderId || ''), 'SENT', messageId, JSON.stringify(latest)).run();
  return { id, messageId };
}

export async function sendOrderBotReport(env: Env, localDate: string, slotTime: string, force = false): Promise<void> {
  const slot = ORDER_BOT_SLOTS[slotTime];
  if (!slot) throw new Error(`Invalid order bot slot: ${slotTime}`);
  if (!isOrderBotReportDay(localDate)) return;
  if (!force) {
    const existing = await env.DB.prepare('SELECT status FROM order_bot_reports WHERE report_date=? AND report_time=?')
      .bind(localDate, slotTime).first<{ status: string }>();
    if (existing?.status === 'SENT') return;
  }
  const shop = await authorizedShop(env);
  if (!shop) throw new Error('Seller OAuth chưa được ủy quyền.');
  const shopCipher = String(shop.cipher || shop.shop_cipher || shop.id || '');
  if (!shopCipher) throw new Error('Không tìm thấy shop_cipher.');
  const cutoffEpoch = zonedDateTimeEpoch(localDate, slot.cutoffTime, env.TIMEZONE || 'Asia/Bangkok');
  const statusOrders = await Promise.all(STATUS_DEFINITIONS.map((status) => currentOrders(env, shopCipher, status.code)));
  const summaries = STATUS_DEFINITIONS.map((status, index) => summarizeOrderStatus(status.label, statusOrders[index], cutoffEpoch));
  const updatedAt = new Date();
  const text = formatOrderBotReport(localDate, slot, summaries, updatedAt, env.TIMEZONE || 'Asia/Bangkok');
  let messageId: string;
  try {
    messageId = await sendOrderBotMessage(env, text);
  } catch (error) {
    if (!/length|too long|too large|message size|limit exceeded/i.test(error instanceof Error ? error.message : String(error))) throw error;
    console.warn('Order bot message exceeded Zalo limit; retrying with 20 breakdown lines per group.');
    messageId = await sendOrderBotMessage(env,
      formatOrderBotReport(localDate, slot, summaries, updatedAt, env.TIMEZONE || 'Asia/Bangkok', 20));
  }
  await env.DB.prepare(`INSERT INTO order_bot_reports(report_date,report_time,status,message_id,payload)
    VALUES(?,?,?,?,?) ON CONFLICT(report_date,report_time) DO UPDATE SET status=excluded.status,message_id=excluded.message_id,
    payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(localDate, slotTime, 'SENT', messageId, JSON.stringify({ cutoffEpoch, summaries, force })).run();
}
