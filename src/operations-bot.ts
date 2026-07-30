import type { Env } from './types';
import { loadSellerRevenueAnalysis } from './seller';
import { loadMainReport } from './reports';
import { loadOperationsAnalysis } from './operations';
import { shiftDate } from './utils';

const API = 'https://bot-api.zaloplatforms.com/bot';
const GREEN = 'c_15a85f';
const RED = 'c_db342e';

export interface OperationsTextStyle { start: number; len: number; st: string[]; }

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

export async function sendOperationsReport(env: Env, reportDate: string, mode: 'DAILY' | 'REALTIME', chatId?: string): Promise<void> {
  if (mode === 'DAILY') {
    const existing = await env.DB.prepare('SELECT status FROM operations_bot_reports WHERE report_date=? AND report_kind=?')
      .bind(reportDate, mode).first<{ status: string }>();
    if (existing?.status === 'SENT') return;
  }
  const previousDate = shiftDate(reportDate, -1);
  const input = { startDate: reportDate, endDate: reportDate, forceRefresh: true };
  const previousInput = { startDate: previousDate, endDate: previousDate, forceRefresh: false };
  const [revenue, ads, previousAds, operations, previousOperations] = await Promise.all([
    loadSellerRevenueAnalysis(env, input),
    loadMainReport(env, { ...input, advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE }, true),
    loadMainReport(env, { ...previousInput, advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE }),
    loadOperationsAnalysis(env, input),
    loadOperationsAnalysis(env, previousInput)
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
  const title = `${mode === 'REALTIME' ? 'Báo cáo realtime chỉ số vận hành' : 'Báo cáo chỉ số vận hành'} Tiktok shop ngày ${displayDate}`;
  const lines = [
    title,
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
    .bind(reportDate, mode, 'SENT', messageId, JSON.stringify({ values, productCount: products.length })).run();
}
