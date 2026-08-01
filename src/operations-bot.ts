import type { Env } from './types';
import { loadSellerRevenueAnalysis } from './seller';
import { loadMainReport } from './reports';
import { loadOperationsAnalysis } from './operations';
import { loadFinanceAnalysis } from './finance';
import { loadContentKocAnalysis, loadContentKocPeriodTotals } from './content-koc';
import { shiftDate } from './utils';

const API = 'https://bot-api.zaloplatforms.com/bot';
const GREEN = 'c_15a85f';
const RED = 'c_db342e';

export interface OperationsTextStyle { start: number; len: number; st: string[]; }
export interface OperationsBotUpdate {
  id: string;
  chatId: string;
  text: string;
  senderIsBot: boolean;
  timestamp: number;
}

async function botApi(env: Env, method: string, payload: unknown): Promise<any> {
  if (!env.ZALO_OPERATIONS_BOT_TOKEN) throw new Error('Missing ZALO_OPERATIONS_BOT_TOKEN.');
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${API}${encodeURIComponent(env.ZALO_OPERATIONS_BOT_TOKEN)}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload)
    });
    const data = await response.json<any>().catch(() => ({}));
    if (response.ok && data.ok === true) return data.result || {};
    lastError = `Zalo Bot API ${data.error_code || response.status}: ${data.description || 'Invalid response'}`;
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, [1000, 2500, 5000][attempt]));
  }
  throw new Error(lastError || 'Zalo Bot API failed.');
}

function whole(value: unknown): string {
  return Math.round(Number(value) || 0).toLocaleString('vi-VN');
}

function compact(value: unknown): string {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  const divisor = absolute >= 1_000_000 ? 1_000_000 : absolute >= 1_000 ? 1_000 : 1;
  const suffix = divisor === 1_000_000 ? 'M' : divisor === 1_000 ? 'K' : '';
  const digits = divisor === 1 ? 0 : absolute >= divisor * 100 ? 0 : absolute >= divisor * 10 ? 1 : 2;
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits }).format(amount / divisor)}${suffix}`;
}

function weeklyCompact(value: unknown): string {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  const divisor = absolute >= 1_000_000 ? 1_000_000 : absolute >= 1_000 ? 1_000 : 1;
  const suffix = divisor === 1_000_000 ? 'M' : divisor === 1_000 ? 'K' : '';
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: divisor === 1 ? 0 : 2 }).format(amount / divisor)}${suffix}`;
}

function weeklyPercent(value: unknown): string {
  return `${(Number(value) || 0).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`;
}

function weeklyTrend(currentValue: unknown, previousValue: unknown): { text: string; direction: 'up' | 'down' | 'flat' } {
  const current = Number(currentValue) || 0;
  const previous = Number(previousValue) || 0;
  if (!previous) return current ? { text: 'mới phát sinh', direction: 'up' } : { text: '≈ giữ nguyên', direction: 'flat' };
  const delta = (current - previous) / Math.abs(previous) * 100;
  if (Math.abs(delta) < 0.005) return { text: '≈ giữ nguyên', direction: 'flat' };
  return { text: `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`,
    direction: delta > 0 ? 'up' : 'down' };
}

function criticalFinanceWarnings(report: any): string[] {
  return [...(report?.warnings || []), ...(report?.previousWarnings || [])]
    .filter((warning) => /Đã quyết toán|Sẽ quyết toán/i.test(String(warning)));
}

function roi(value: unknown): string {
  return (Number(value) || 0).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function trend(currentValue: unknown, previousValue: unknown): { text: string; direction: 'up' | 'down' | 'flat' } {
  const current = Number(currentValue) || 0;
  const previous = Number(previousValue) || 0;
  if (!previous) return current ? { text: 'mới phát sinh', direction: 'up' } : { text: '≈ giữ nguyên', direction: 'flat' };
  const delta = (current - previous) / Math.abs(previous) * 100;
  if (Math.abs(delta) < 0.05) return { text: '≈ giữ nguyên', direction: 'flat' };
  return {
    text: `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`,
    direction: delta > 0 ? 'up' : 'down'
  };
}

function shortProductName(value: unknown): string {
  const name = String(value || 'Sản phẩm').replace(/\s+/g, ' ').trim();
  return name.length > 46 ? `${name.slice(0, 43).trimEnd()}...` : name;
}

export function formatOperationsUpdatedAt(date: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}:${parts.second} ${Number(parts.day)}/${Number(parts.month)}/${parts.year}`;
}

export function buildOperationsReportStyles(text: string): OperationsTextStyle[] {
  const styles: OperationsTextStyle[] = [];
  const add = (start: number, len: number, ...st: string[]) => { if (start >= 0 && len > 0) styles.push({ start, len, st }); };
  const titleEnd = text.indexOf('\n');
  add(0, titleEnd < 0 ? text.length : titleEnd, 'f_15', 'i');
  add(titleEnd + 1, text.length - titleEnd - 1, 'f_13');
  const labels = ['1. GMV:', '2. ĐƠN HÀNG:', '3. AOV:', '4. CHI TIÊU ADS:', '5. ROI:', '6. Tỷ lệ hủy:', 'Sản phẩm'];
  for (const label of labels) {
    const start = text.indexOf(label);
    add(start, label.length, 'b', ...(label === 'Sản phẩm' ? ['u', GREEN] : []));
  }
  const productSection = text.indexOf('\nSản phẩm\n');
  if (productSection >= 0) {
    const productGmvPattern = /^GMV:/gm;
    productGmvPattern.lastIndex = productSection;
    let match: RegExpExecArray | null;
    while ((match = productGmvPattern.exec(text)) !== null) add(match.index, match[0].length, 'b');
  }
  const lines = text.split('\n'); let offset = 0;
  const badWhenUp = new Set(['4. CHI TIÊU ADS:', '6. Tỷ lệ hủy:']);
  for (const line of lines) {
    const match = line.match(/(?:↑|↓)\s*[\d.,]+%/);
    if (match) {
      const label = Array.from(badWhenUp).find((item) => line.startsWith(item));
      const increasing = match[0].startsWith('↑');
      const good = label ? !increasing : increasing;
      add(offset + (match.index || 0), match[0].length, good ? GREEN : RED);
    }
    offset += line.length + 1;
  }
  return styles;
}

export interface WeeklyOperationsReportData {
  title?: string;
  startDate: string;
  endDate: string;
  metrics: Array<{ label: string; value: string; change?: ReturnType<typeof weeklyTrend>; badWhenUp?: boolean }>;
  sources: {
    affiliate: { total: number; live: number; video: number; productCard: number; previousTotal: number; videoCount: number; videoRoi: number };
    seller: { total: number; live: number; video: number; productCard: number; previousTotal: number; videoCount: number; videoRoi: number };
  };
}

function displayShortDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

export function formatWeeklyOperationsReport(data: WeeklyOperationsReportData): { text: string; styles: OperationsTextStyle[] } {
  const totalGmv = data.sources.affiliate.total + data.sources.seller.total;
  const contribution = (value: number) => weeklyPercent(totalGmv ? value / totalGmv * 100 : 0);
  const sourceLines = (label: string, source: WeeklyOperationsReportData['sources']['affiliate']) => [
    `${label} (Đóng góp ${contribution(source.total)}): ${weeklyCompact(source.total)} (${weeklyTrend(source.total, source.previousTotal).text})`,
    `› LIVE (Đóng góp ${contribution(source.live)})`,
    `› Video (Đóng góp ${contribution(source.video)}) : ${whole(source.videoCount)} Video - Roi ${roi(source.videoRoi)}`,
    `› Thẻ sản phẩm (Đóng góp ${contribution(source.productCard)})`
  ];
  const text = [
    data.title || `Báo cáo chỉ số vận hành Tiktok shop tuần ${displayShortDate(data.startDate).slice(0, 5)}-${displayShortDate(data.endDate)}`,
    '', 'Tổng quan',
    ...data.metrics.map((metric) => `${metric.label} ${metric.value}${metric.change ? ` (${metric.change.text})` : ''}`),
    '', 'Nguồn',
    ...sourceLines('Liên kết', data.sources.affiliate),
    ...sourceLines('Người bán', data.sources.seller)
  ].join('\n');
  const styles: OperationsTextStyle[] = [];
  const add = (start: number, len: number, ...st: string[]) => { if (start >= 0 && len > 0) styles.push({ start, len, st }); };
  const titleEnd = text.indexOf('\n');
  add(0, titleEnd, 'f_15', 'i');
  add(titleEnd + 1, text.length - titleEnd - 1, 'f_13');
  for (const section of ['Tổng quan', 'Nguồn']) {
    const start = text.indexOf(`\n${section}\n`) + 1;
    add(start, section.length, 'f_13', 'u', 'b', GREEN);
  }
  const lines = text.split('\n');
  let offset = 0;
  const badWhenUp = new Set(data.metrics.filter((metric) => metric.badWhenUp).map((metric) => metric.label));
  for (const line of lines) {
    const metric = data.metrics.find((item) => line.startsWith(item.label));
    if (metric) {
      add(offset, line.length, 'f_13');
      add(offset, metric.label.length, 'b');
    }
    const sourceLabel = line.match(/^(Liên kết|Người bán)/)?.[0];
    if (sourceLabel) add(offset, sourceLabel.length, 'b');
    if (line.startsWith('›')) {
      add(offset, line.length, 'f_13');
      for (const pattern of [/Đóng góp [\d.,]+%/g, /\d+ Video - Roi [\d.]+/g]) {
        for (const emphasis of line.matchAll(pattern)) add(offset + (emphasis.index || 0), emphasis[0].length, 'b');
      }
    }
    const change = line.match(/(?:↑|↓)\s*[\d.,]+%|mới phát sinh|≈ giữ nguyên/);
    if (change) {
      const increasing = change[0].startsWith('↑') || change[0] === 'mới phát sinh';
      const metricBadWhenUp = metric ? badWhenUp.has(metric.label) : false;
      add(offset + (change.index || 0), change[0].length, metricBadWhenUp ? (increasing ? RED : GREEN) : (increasing ? GREEN : RED));
    }
    offset += line.length + 1;
  }
  return { text, styles };
}

export async function sendOperationsMessage(env: Env, text: string, styles = buildOperationsReportStyles(text), chatId?: string): Promise<string> {
  const destination = chatId || env.ZALO_OPERATIONS_GROUP_CHAT_ID;
  if (!destination) throw new Error('Missing ZALO_OPERATIONS_GROUP_CHAT_ID.');
  const result = await botApi(env, 'sendMessage', { chat_id: destination, text, text_styles: styles });
  return String(result.message_id || '');
}

export async function ensureOperationsBotWebhook(env: Env): Promise<void> {
  if (!env.ZALO_OPERATIONS_WEBHOOK_SECRET || !env.PUBLIC_BASE_URL) throw new Error('Missing operations bot webhook configuration.');
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/zalo-operations`;
  const info = await botApi(env, 'getWebhookInfo', {}).catch(() => ({}));
  if (String(info?.url || '') !== url) await botApi(env, 'setWebhook', { url, secret_token: env.ZALO_OPERATIONS_WEBHOOK_SECRET });
}

function normalizeOperationsUpdate(value: any): OperationsBotUpdate {
  const update = value?.result || value || {};
  const message = update.message || update.edited_message || {};
  const rawTimestamp = Number(message.date || message.timestamp || update.timestamp || update.date || 0);
  return {
    id: String(update.update_id || update.event_id || message.message_id || ''),
    chatId: String(message.chat?.id || message.chat_id || update.chat_id || update.group_id || ''),
    text: String(message.text || message.caption || update.text || update.message_text || update.content || ''),
    senderIsBot: Boolean(message.from?.is_bot ?? update.is_bot ?? update.sender_is_bot),
    timestamp: rawTimestamp > 0 && rawTimestamp < 100_000_000_000 ? rawTimestamp * 1000 : rawTimestamp
  };
}

export async function pollOperationsBot(env: Env, timeoutSeconds = 25): Promise<OperationsBotUpdate[]> {
  if (!env.ZALO_OPERATIONS_BOT_TOKEN) return [];
  const mode = await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_OPERATIONS_INBOX_MODE'")
    .first<{ value: string }>();
  if (mode?.value !== 'POLLING') {
    const info = await botApi(env, 'getWebhookInfo', {}).catch(() => ({}));
    if (String(info?.url || '')) await botApi(env, 'deleteWebhook', {});
    await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES('ZALO_OPERATIONS_INBOX_MODE','POLLING')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run();
  }
  const response = await fetch(`${API}${encodeURIComponent(env.ZALO_OPERATIONS_BOT_TOKEN)}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ timeout: String(Math.max(1, Math.min(30, timeoutSeconds))) })
  });
  const data = await response.json<any>().catch(() => ({}));
  if (response.status === 408 || /request timeout/i.test(String(data?.description || data?.message || ''))) return [];
  if (!response.ok || data.ok !== true) throw new Error(`Zalo Bot API ${data.error_code || response.status}: ${data.description || 'getUpdates failed'}`);
  const result = data.result || [];
  const items = Array.isArray(result) ? result : Array.isArray(result.updates) ? result.updates : [];
  return items.map(normalizeOperationsUpdate).filter((update: OperationsBotUpdate) => update.id);
}

export async function sendOperationsReport(env: Env, reportDate: string, mode: 'DAILY' | 'REALTIME', chatId?: string,
  operationsDate = reportDate): Promise<void> {
  if (mode === 'DAILY') {
    const existing = await env.DB.prepare('SELECT status FROM operations_bot_reports WHERE report_date=? AND report_kind=?')
      .bind(reportDate, mode).first<{ status: string }>();
    if (existing?.status === 'SENT') return;
  }
  const previousDate = shiftDate(reportDate, -1);
  const previousOperationsDate = shiftDate(operationsDate, -1);
  const input = { startDate: reportDate, endDate: reportDate, forceRefresh: true };
  const previousInput = { startDate: previousDate, endDate: previousDate, forceRefresh: false };
  const operationsInput = { startDate: operationsDate, endDate: operationsDate, forceRefresh: true };
  const previousOperationsInput = { startDate: previousOperationsDate, endDate: previousOperationsDate, forceRefresh: false };
  const [revenue, ads, previousAds, operations, previousOperations] = await Promise.all([
    loadSellerRevenueAnalysis(env, input),
    loadMainReport(env, { ...input, advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE }, true),
    loadMainReport(env, { ...previousInput, advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE }),
    loadOperationsAnalysis(env, operationsInput),
    loadOperationsAnalysis(env, previousOperationsInput)
  ]);
  const currentRevenue = revenue.totals || {};
  const previousRevenue = revenue.previousTotals || {};
  const values = [
    { label: '1. GMV:', value: compact(currentRevenue.grossRevenue), change: trend(currentRevenue.grossRevenue, previousRevenue.grossRevenue) },
    { label: '2. ĐƠN HÀNG:', value: whole(currentRevenue.orders), change: trend(currentRevenue.orders, previousRevenue.orders) },
    { label: '3. AOV:', value: compact(currentRevenue.aov), change: trend(currentRevenue.aov, previousRevenue.aov) },
    { label: '4. CHI TIÊU ADS:', value: compact(ads.totals?.cost), change: trend(ads.totals?.cost, previousAds.totals?.cost) },
    { label: '5. ROI:', value: roi(ads.totals?.roi), change: trend(ads.totals?.roi, previousAds.totals?.roi) },
    { label: '6. Tỷ lệ hủy:', value: `${((Number(operations.totals?.cancellationRate) || 0) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`, change: trend(operations.totals?.cancellationRate, previousOperations.totals?.cancellationRate) }
  ];
  const products = (revenue.gmvAttribution?.products || []).filter((product: any) => Number(product.gmv) > 0);
  const displayDate = reportDate.split('-').reverse().join('/');
  const title = mode === 'REALTIME'
    ? 'Báo cáo realtime chỉ số vận hành Tiktok shop'
    : `Báo cáo chỉ số vận hành Tiktok shop ngày ${displayDate}`;
  const lines = [
    title,
    ...(mode === 'REALTIME' ? [`Cập nhật: ${formatOperationsUpdatedAt(new Date(), env.TIMEZONE || 'Asia/Bangkok')}`] : []),
    '',
    ...values.map((item) => `${item.label} ${item.value} ${item.label === '6. Tỷ lệ hủy:' ? item.change.text : `(${item.change.text})`}`),
    '',
    'Sản phẩm'
  ];
  if (products.length) products.forEach((product: any, index: number) => {
    lines.push(`${index + 1}. ${shortProductName(product.name)}`, `GMV: ${compact(product.gmv)}`);
  });
  else lines.push('Không có sản phẩm phát sinh GMV.');
  const text = lines.join('\n');
  const messageId = await sendOperationsMessage(env, text, buildOperationsReportStyles(text), chatId);
  if (mode === 'DAILY') await env.DB.prepare(`INSERT INTO operations_bot_reports(report_date,report_kind,status,message_id,payload)
    VALUES(?,?,?,?,?) ON CONFLICT(report_date,report_kind) DO UPDATE SET status=excluded.status,message_id=excluded.message_id,payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(reportDate, mode, 'SENT', messageId, JSON.stringify({ values, productCount: products.length, operationsDate })).run();
}

export async function buildWeeklyOperationsReport(env: Env, saturdayDate: string): Promise<{ text: string; styles: OperationsTextStyle[] }> {
  const endDate = shiftDate(saturdayDate, -1);
  const startDate = shiftDate(saturdayDate, -7);
  const previousEndDate = shiftDate(startDate, -1);
  const previousStartDate = shiftDate(startDate, -7);
  const currentInput = { startDate, endDate, forceRefresh: false };
  const previousInput = { startDate: previousStartDate, endDate: previousEndDate, forceRefresh: false };
  const reportScope = { advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE };
  const [revenue, ads, previousAds, finance, operations, content] = await Promise.all([
    loadSellerRevenueAnalysis(env, currentInput),
    loadMainReport(env, { ...reportScope, startDate, endDate }),
    loadMainReport(env, { ...reportScope, startDate: previousStartDate, endDate: previousEndDate }),
    loadFinanceAnalysis(env, currentInput),
    loadOperationsAnalysis(env, currentInput),
    loadContentKocAnalysis(env, { ...currentInput, ...reportScope })
  ]);
  const currentRevenue = revenue.totals || {};
  const previousRevenue = revenue.previousTotals || {};
  const currentAttribution = revenue.gmvAttribution || {};
  const previousAttribution = revenue.previousGmvAttribution || {};
  const currentFinance = finance.current?.summary || {};
  const weeklyFinanceWarnings = criticalFinanceWarnings(finance);
  if (weeklyFinanceWarnings.length) {
    throw new Error(`Dữ liệu Finance tuần chưa đầy đủ: ${weeklyFinanceWarnings.join(' | ')}`);
  }
  const previousFinance = finance.previous || {};
  const contentTotals = content.totals || {};
  const source = (key: 'affiliate' | 'seller') => {
    const value = currentAttribution[key] || {};
    const video = contentTotals[key === 'affiliate' ? 'koc' : 'seller'] || {};
    return {
      total: Number(value.total) || 0,
      live: Number(value.live) || 0,
      video: Number(value.video) || 0,
      productCard: Number(value.productCard) || 0,
      previousTotal: Number(previousAttribution[key]?.total) || 0,
      videoCount: Number(video.videoCount) || 0,
      videoRoi: Number(video.adsSpend) ? Number(video.gmv) / Number(video.adsSpend) : 0
    };
  };
  return formatWeeklyOperationsReport({
    startDate, endDate,
    metrics: [
      { label: '1. GMV:', value: weeklyCompact(currentRevenue.grossRevenue), change: weeklyTrend(currentRevenue.grossRevenue, previousRevenue.grossRevenue) },
      { label: '2. ĐƠN HÀNG:', value: whole(currentRevenue.orders), change: weeklyTrend(currentRevenue.orders, previousRevenue.orders) },
      { label: '3. AOV:', value: weeklyCompact(currentRevenue.aov), change: weeklyTrend(currentRevenue.aov, previousRevenue.aov) },
      { label: '4. CHI TIÊU ADS:', value: weeklyCompact(ads.totals?.cost), change: weeklyTrend(ads.totals?.cost, previousAds.totals?.cost), badWhenUp: true },
      { label: '5. Tổng phí sàn:', value: weeklyCompact(currentFinance.feeTax), change: weeklyTrend(currentFinance.feeTax, previousFinance.feeTax), badWhenUp: true },
      { label: '6. Hoa hồng KOC:', value: weeklyCompact(currentFinance.affiliate), change: weeklyTrend(currentFinance.affiliate, previousFinance.affiliate), badWhenUp: true },
      { label: '7. Hoàn tiền:', value: weeklyCompact(currentFinance.refunds), change: weeklyTrend(currentFinance.refunds, previousFinance.refunds), badWhenUp: true },
      { label: '8. Tỷ lệ hủy:', value: weeklyPercent((Number(operations.totals?.cancellationRate) || 0) * 100) }
    ],
    sources: { affiliate: source('affiliate'), seller: source('seller') }
  });
}

export async function prepareWeeklyOperationsReport(env: Env, saturdayDate: string, stage: number): Promise<void> {
  const endDate = shiftDate(saturdayDate, -1);
  const startDate = shiftDate(saturdayDate, -7);
  const previousEndDate = shiftDate(startDate, -1);
  const previousStartDate = shiftDate(startDate, -7);
  const scope = { advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE };
  if (stage === 0) await loadSellerRevenueAnalysis(env, { startDate, endDate, forceRefresh: true });
  else if (stage === 1) {
    await loadMainReport(env, { ...scope, startDate, endDate }, true);
    await loadMainReport(env, { ...scope, startDate: previousStartDate, endDate: previousEndDate });
  } else if (stage === 2) {
    const finance = await loadFinanceAnalysis(env, { startDate, endDate, forceRefresh: true });
    if (criticalFinanceWarnings(finance).length) throw new Error('TikTok Finance chưa trả đủ dữ liệu hai tuần.');
  } else if (stage === 3) await loadOperationsAnalysis(env, { startDate, endDate, forceRefresh: true });
  else if (stage === 4) await loadContentKocAnalysis(env, { ...scope, startDate, endDate, forceRefresh: true });
  else return sendWeeklyOperationsReport(env, saturdayDate);
  await env.TASK_QUEUE.send({ type: 'operations-weekly-prepare', saturdayDate, stage: stage + 1 });
}

export async function sendWeeklyOperationsReport(env: Env, saturdayDate: string): Promise<void> {
  const reportDate = shiftDate(saturdayDate, -1);
  const existing = await env.DB.prepare('SELECT status FROM operations_bot_reports WHERE report_date=? AND report_kind=?')
    .bind(reportDate, 'WEEKLY').first<{ status: string }>();
  if (existing?.status === 'SENT') return;
  const formatted = await buildWeeklyOperationsReport(env, saturdayDate);
  const messageId = await sendOperationsMessage(env, formatted.text, formatted.styles);
  await env.DB.prepare(`INSERT INTO operations_bot_reports(report_date,report_kind,status,message_id,payload)
    VALUES(?,?,?,?,?) ON CONFLICT(report_date,report_kind) DO UPDATE SET status=excluded.status,message_id=excluded.message_id,
    payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(reportDate, 'WEEKLY', 'SENT', messageId, JSON.stringify({ saturdayDate })).run();
}

export function monthlyRanges(firstDayOfMonth: string): { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string } {
  const endDate = shiftDate(firstDayOfMonth, -1);
  const startDate = `${endDate.slice(0, 7)}-01`;
  const previousEndDate = shiftDate(startDate, -1);
  return { startDate, endDate, previousStartDate: `${previousEndDate.slice(0, 7)}-01`, previousEndDate };
}

function periodChunks(startDate: string, endDate: string, days = 7): Array<{ startDate: string; endDate: string }> {
  const chunks: Array<{ startDate: string; endDate: string }> = [];
  for (let start = startDate; start <= endDate; start = shiftDate(start, days)) {
    const candidate = shiftDate(start, days - 1);
    chunks.push({ startDate: start, endDate: candidate < endDate ? candidate : endDate });
  }
  return chunks;
}

function sumFinanceReports(reports: any[]): any {
  return reports.reduce((total, report) => {
    const summary = report.current?.summary || {};
    for (const key of ['sellerSubtotal', 'feeTax', 'affiliate', 'adsCost', 'refunds']) total[key] += Number(summary[key]) || 0;
    return total;
  }, { sellerSubtotal: 0, feeTax: 0, affiliate: 0, adsCost: 0, refunds: 0 });
}

export async function buildMonthlyOperationsReport(env: Env, firstDayOfMonth: string): Promise<{ text: string; styles: OperationsTextStyle[] }> {
  const { startDate, endDate, previousStartDate, previousEndDate } = monthlyRanges(firstDayOfMonth);
  const currentInput = { startDate, endDate, forceRefresh: false };
  const previousInput = { startDate: previousStartDate, endDate: previousEndDate, forceRefresh: false };
  const scope = { advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE };
  const currentChunks = periodChunks(startDate, endDate);
  const previousChunks = periodChunks(previousStartDate, previousEndDate);
  const [revenue, previousRevenueReport, ads, previousAds, financeReports, previousFinanceReports, operations, content] = await Promise.all([
    loadSellerRevenueAnalysis(env, currentInput),
    loadSellerRevenueAnalysis(env, previousInput),
    loadMainReport(env, { ...scope, startDate, endDate }),
    loadMainReport(env, { ...scope, startDate: previousStartDate, endDate: previousEndDate }),
    Promise.all(currentChunks.map((chunk) => loadFinanceAnalysis(env, { ...chunk, forceRefresh: false }))),
    Promise.all(previousChunks.map((chunk) => loadFinanceAnalysis(env, { ...chunk, forceRefresh: false }))),
    loadOperationsAnalysis(env, currentInput),
    loadContentKocPeriodTotals(env, { ...scope, ...currentInput })
  ]);
  const financeWarnings = [...financeReports, ...previousFinanceReports].flatMap(criticalFinanceWarnings);
  if (financeWarnings.length) throw new Error(`Dữ liệu Finance tháng chưa đầy đủ: ${financeWarnings.join(' | ')}`);
  const currentRevenue = revenue.totals || {};
  const previousRevenue = previousRevenueReport.totals || {};
  const currentFinance = sumFinanceReports(financeReports);
  const previousFinance = sumFinanceReports(previousFinanceReports);
  const currentAttribution = revenue.gmvAttribution || {};
  const previousAttribution = previousRevenueReport.gmvAttribution || {};
  const contentTotals = content.totals || {};
  const source = (key: 'affiliate' | 'seller') => {
    const value = currentAttribution[key] || {};
    const video = contentTotals[key === 'affiliate' ? 'koc' : 'seller'] || {};
    return { total: Number(value.total) || 0, live: Number(value.live) || 0, video: Number(value.video) || 0,
      productCard: Number(value.productCard) || 0, previousTotal: Number(previousAttribution[key]?.total) || 0,
      videoCount: Number(video.videoCount) || 0,
      videoRoi: Number(video.adsSpend) ? Number(video.gmv) / Number(video.adsSpend) : 0 };
  };
  return formatWeeklyOperationsReport({
    title: `Báo cáo chỉ số vận hành Tiktok shop tháng ${endDate.slice(5, 7)}/${endDate.slice(0, 4)}`,
    startDate, endDate,
    metrics: [
      { label: '1. GMV:', value: weeklyCompact(currentRevenue.grossRevenue), change: weeklyTrend(currentRevenue.grossRevenue, previousRevenue.grossRevenue) },
      { label: '2. ĐƠN HÀNG:', value: whole(currentRevenue.orders), change: weeklyTrend(currentRevenue.orders, previousRevenue.orders) },
      { label: '3. AOV:', value: weeklyCompact(currentRevenue.aov), change: weeklyTrend(currentRevenue.aov, previousRevenue.aov) },
      { label: '4. CHI TIÊU ADS:', value: weeklyCompact(ads.totals?.cost), change: weeklyTrend(ads.totals?.cost, previousAds.totals?.cost), badWhenUp: true },
      { label: '5. Tổng phí sàn:', value: weeklyCompact(currentFinance.feeTax), change: weeklyTrend(currentFinance.feeTax, previousFinance.feeTax), badWhenUp: true },
      { label: '6. Hoa hồng KOC:', value: weeklyCompact(currentFinance.affiliate), change: weeklyTrend(currentFinance.affiliate, previousFinance.affiliate), badWhenUp: true },
      { label: '7. Hoàn tiền:', value: weeklyCompact(currentFinance.refunds), change: weeklyTrend(currentFinance.refunds, previousFinance.refunds), badWhenUp: true },
      { label: '8. Tỷ lệ hủy:', value: weeklyPercent((Number(operations.totals?.cancellationRate) || 0) * 100) }
    ],
    sources: { affiliate: source('affiliate'), seller: source('seller') }
  });
}

export async function prepareMonthlyOperationsReport(env: Env, firstDayOfMonth: string, stage: number): Promise<void> {
  const { startDate, endDate, previousStartDate, previousEndDate } = monthlyRanges(firstDayOfMonth);
  const scope = { advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE };
  const jobs: Array<() => Promise<unknown>> = [
    () => loadSellerRevenueAnalysis(env, { startDate, endDate, forceRefresh: true }),
    () => loadSellerRevenueAnalysis(env, { startDate: previousStartDate, endDate: previousEndDate, forceRefresh: true }),
    () => loadMainReport(env, { ...scope, startDate, endDate }, true),
    () => loadMainReport(env, { ...scope, startDate: previousStartDate, endDate: previousEndDate })
  ];
  for (const chunk of [...periodChunks(startDate, endDate), ...periodChunks(previousStartDate, previousEndDate)]) {
    jobs.push(async () => {
      const value = await loadFinanceAnalysis(env, { ...chunk, forceRefresh: true });
      if (criticalFinanceWarnings(value).length) throw new Error(`TikTok Finance ${chunk.startDate}-${chunk.endDate} chưa đầy đủ.`);
      return value;
    });
  }
  jobs.push(() => loadOperationsAnalysis(env, { startDate, endDate, forceRefresh: true }));
  jobs.push(() => loadContentKocPeriodTotals(env, { ...scope, startDate, endDate, forceRefresh: true }));
  if (stage >= jobs.length) return sendMonthlyOperationsReport(env, firstDayOfMonth);
  await jobs[stage]();
  await env.TASK_QUEUE.send({ type: 'operations-monthly-prepare', firstDayOfMonth, stage: stage + 1 });
}

export async function sendMonthlyOperationsReport(env: Env, firstDayOfMonth: string): Promise<void> {
  const { endDate } = monthlyRanges(firstDayOfMonth);
  const existing = await env.DB.prepare('SELECT status FROM operations_bot_reports WHERE report_date=? AND report_kind=?')
    .bind(endDate, 'MONTHLY').first<{ status: string }>();
  if (existing?.status === 'SENT') return;
  const formatted = await buildMonthlyOperationsReport(env, firstDayOfMonth);
  const messageId = await sendOperationsMessage(env, formatted.text, formatted.styles);
  await env.DB.prepare(`INSERT INTO operations_bot_reports(report_date,report_kind,status,message_id,payload)
    VALUES(?,?,?,?,?) ON CONFLICT(report_date,report_kind) DO UPDATE SET status=excluded.status,message_id=excluded.message_id,
    payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(endDate, 'MONTHLY', 'SENT', messageId, JSON.stringify({ firstDayOfMonth })).run();
}
