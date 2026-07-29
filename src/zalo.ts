import type { Env } from './types';
import { loadCreativeSummaries, loadMainReport, loadVideoStats } from './reports';
import { dateInTimezone } from './utils';

const API = 'https://bot-api.zaloplatforms.com/bot';

async function zaloApi(env: Env, method: string, payload: unknown): Promise<any> {
  if (!env.ZALO_BOT_TOKEN) throw new Error('Missing ZALO_BOT_TOKEN.');
  const response = await fetch(`${API}${encodeURIComponent(env.ZALO_BOT_TOKEN)}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload)
  });
  const data = await response.json<any>().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error(`Zalo Bot API ${data.error_code || response.status}: ${data.description || 'Invalid response'}`);
  return data.result || {};
}

export async function sendMessage(env: Env, text: string, chatId?: string): Promise<string> {
  const destination = chatId || env.ZALO_GROUP_CHAT_ID;
  if (!destination) throw new Error('Missing ZALO_GROUP_CHAT_ID.');
  const result = await zaloApi(env, 'sendMessage', { chat_id: destination, text });
  return String(result.message_id || '');
}

function integer(value: unknown): string { return Math.round(Number(value) || 0).toLocaleString('vi-VN'); }
function recommendation(items: any[]): string[] {
  return items?.length ? items.map((item) => `${item.itemId} | ${String(item.reason || '')}`) : ['Không có'];
}

export async function sendScheduledReport(env: Env, reportDate: string, reportHour: number): Promise<void> {
  const existing = await env.DB.prepare('SELECT status FROM scheduled_reports WHERE report_date=? AND report_hour=?')
    .bind(reportDate, reportHour).first<{status:string}>();
  if (existing?.status === 'SENT') return;
  const base = { advertiserId: env.DEFAULT_ADVERTISER_ID, storeId: env.DEFAULT_STORE_CODE, startDate: reportDate, endDate: reportDate };
  const report = await loadMainReport(env, base, true);
  const summary = await loadCreativeSummaries(env, { ...base, products: report.products,
    allContexts: report.creativeContexts, availableProducts: report.availableProductCount,
    forceRefresh: true });
  const hourlyRow = report.hourly?.[reportHour - 1];
  if (!hourlyRow?.metrics) throw new Error(`Không tìm thấy dữ liệu khung giờ ${reportHour}:00.`);
  const display = reportDate.split('-').reverse().join('/');
  const t = hourlyRow.metrics;
  const text = [
    `Chỉ số ADS ${display} - ${String(reportHour).padStart(2,'0')}:00`,
    `Cost: ${integer(t.cost)}`,
    `SKU orders: ${integer(t.orders)}`,
    `Cost / order: ${integer(t.costPerOrder)}`,
    `Gross revenue: ${integer(t.grossRevenue)}`,
    `ROI: ${Number(t.roi || 0).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}`,
    '',
    '- Boost:',
    ...recommendation(summary.videoEvaluation?.boost),
    '- Tắt:',
    ...recommendation(summary.videoEvaluation?.stop)
  ].join('\n');
  const messageId = await sendMessage(env, text);
  await env.DB.prepare(`INSERT INTO scheduled_reports(report_date,report_hour,status,message_id,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(report_date,report_hour) DO UPDATE SET status=excluded.status,message_id=excluded.message_id,payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(reportDate, reportHour, 'SENT', messageId, JSON.stringify({ totals:t })).run();
  await env.DB.prepare(`INSERT INTO hourly_metrics(advertiser_id,store_id,report_date,report_hour,metrics_json) VALUES(?,?,?,?,?)
    ON CONFLICT(advertiser_id,store_id,report_date,report_hour) DO UPDATE SET metrics_json=excluded.metrics_json`)
    .bind(base.advertiserId,base.storeId,reportDate,reportHour,JSON.stringify(t)).run();
}

function deepFind(input: any, keys: string[]): any {
  if (!input || typeof input !== 'object') return undefined;
  for (const key of keys) if (input[key] !== undefined) return input[key];
  for (const value of Object.values(input)) { const found = deepFind(value, keys); if (found !== undefined) return found; }
  return undefined;
}

export function normalizeZaloEvent(payload: any): { id?: string; chatId: string; text: string; senderIsBot: boolean } {
  return { id: String(deepFind(payload,['update_id','message_id','event_id']) || ''),
    chatId: String(deepFind(payload,['chat_id','group_id']) || ''), text: String(deepFind(payload,['text','message_text','content']) || ''),
    senderIsBot: Boolean(deepFind(payload,['is_bot','sender_is_bot'])) };
}

export async function processZaloVideo(env: Env, eventId: number): Promise<void> {
  const row = await env.DB.prepare('SELECT payload FROM webhook_events WHERE id=?').bind(eventId).first<{payload:string}>();
  if (!row) return; const event=normalizeZaloEvent(JSON.parse(row.payload));
  if (event.senderIsBot || (env.ZALO_GROUP_CHAT_ID && event.chatId !== env.ZALO_GROUP_CHAT_ID)) return;
  const newer=await env.DB.prepare("SELECT id,payload FROM webhook_events WHERE provider='zalo' AND id>? AND status='PENDING' ORDER BY id DESC LIMIT 20").bind(eventId).all<{id:number,payload:string}>();
  if(newer.results.some(item=>normalizeZaloEvent(JSON.parse(item.payload)).chatId===event.chatId)){
    await env.DB.prepare("UPDATE webhook_events SET status='SKIPPED',processed_at=? WHERE id=?").bind(Date.now(),eventId).run();return;
  }
  const match=event.text.match(/(?:tiktok\.com\/[^\s]*\/video\/|\b)(\d{19,30})(?:\b|[?/_])/i);
  if(!match){await sendMessage(env,'Dinh dang link sai, vui long gui lai dinh dang: @Bot ADS - ALF https://www.tiktok.com/@username/video/POST_ID',event.chatId);return;}
  const endDate=dateInTimezone(new Date(),env.TIMEZONE);const input={advertiserId:env.DEFAULT_ADVERTISER_ID,storeId:env.DEFAULT_STORE_CODE,itemId:match[1],endDate,metadataContexts:[]};
  const report=await loadMainReport(env,{advertiserId:input.advertiserId,storeId:input.storeId,startDate:endDate,endDate});input.metadataContexts=report.creativeContexts;
  const stats=await loadVideoStats(env,input);const totals=stats.daily.reduce((a:any,p:any)=>({cost:a.cost+p.cost,orders:a.orders+p.orders}),{cost:0,orders:0});
  const chart={type:'line',data:{labels:stats.daily.map((p:any)=>p.date.slice(5)),datasets:[
    {label:'Cost',data:stats.daily.map((p:any)=>p.cost),borderColor:'#079d9b',pointRadius:2,yAxisID:'y'},
    {label:'SKU orders',data:stats.daily.map((p:any)=>p.orders),borderColor:'#ffad28',pointRadius:2,yAxisID:'y1'}]},options:{plugins:{legend:{position:'top'}},scales:{y:{position:'left'},y1:{position:'right',grid:{drawOnChartArea:false}}}}};
  const chartUrl=`https://quickchart.io/chart?width=1000&height=520&format=png&c=${encodeURIComponent(JSON.stringify(chart))}`;
  const caption=`30D\nCost: ${integer(totals.cost)}\nGross revenue: ${integer(stats.video?.grossRevenue || 0)}\nCost per order: ${integer(totals.orders?totals.cost/totals.orders:0)}`;
  await zaloApi(env,'sendPhoto',{chat_id:event.chatId||env.ZALO_GROUP_CHAT_ID,photo:chartUrl,caption});
  await env.DB.prepare("UPDATE webhook_events SET status='DONE',processed_at=? WHERE id=?").bind(Date.now(),eventId).run();
}
