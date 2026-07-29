import type { Env } from './types';
import { loadCreativeSummaries, loadMainReport, loadVideoStats } from './reports';
import { cachePut, dateInTimezone } from './utils';

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

export interface ZaloTextStyle { start: number; len: number; st: string[]; }

export async function sendMessage(env: Env, text: string, chatId?: string, textStyles?: ZaloTextStyle[]): Promise<string> {
  const destination = chatId || env.ZALO_GROUP_CHAT_ID;
  if (!destination) throw new Error('Missing ZALO_GROUP_CHAT_ID.');
  const payload:any={chat_id:destination,text};
  if(textStyles?.length)payload.text_styles=textStyles;
  const result = await zaloApi(env, 'sendMessage', payload);
  return String(result.message_id || '');
}

function integer(value: unknown): string { return Math.round(Number(value) || 0).toLocaleString('vi-VN'); }
function recommendation(items: any[]): string[] {
  return items?.length ? items.map((item) => `${item.itemId} | ${String(item.reason || '')}`) : ['Không có'];
}

export function buildAdsStyles(text:string):ZaloTextStyle[]{
  const styles:ZaloTextStyle[]=[];
  const green='c_15a85f',red='c_db342e';
  const add=(start:number,len:number,...st:string[])=>{if(start>=0&&len>0)styles.push({start,len,st});};
  const titleEnd=text.indexOf('\n');
  add(0,titleEnd<0?text.length:titleEnd,'i');
  const bodyStart=titleEnd<0?text.length:titleEnd+1;
  add(bodyStart,text.length-bodyStart,'f_13','b');

  const colorTrend=(label:string,increaseIsGood:boolean)=>{
    const start=text.indexOf(label);if(start<0)return;
    const end=text.indexOf('\n',start);const line=text.slice(start,end<0?text.length:end);
    const match=line.match(/[↑↓]\s*[\d.,]+%/);if(!match)return;
    const good=match[0].startsWith('↑')?increaseIsGood:!increaseIsGood;
    add(start+(match.index||0),match[0].length,good?green:red);
  };
  colorTrend('Cost:',false);colorTrend('Gross revenue:',true);colorTrend('Cost / order:',false);

  const boostStart=text.indexOf('- Boost:');const stopStart=text.indexOf('- Tắt:');
  add(boostStart,'- Boost:'.length,green);add(stopStart,'- Tắt:'.length,red);
  const colorMatches=(source:string,offset:number,pattern:RegExp,color:string,group=0)=>{
    let match:RegExpExecArray|null;
    while((match=pattern.exec(source))!==null){
      const value=match[group]||match[0];const within=group?match[0].lastIndexOf(value):0;
      add(offset+match.index+within,value.length,color);
    }
  };
  if(boostStart>=0){
    const end=stopStart>=0?stopStart:text.length;const source=text.slice(boostStart,end);
    colorMatches(source,boostStart,/ROI\s+[\d.,]+/g,green);
    colorMatches(source,boostStart,/mốc\s+([\d.,]+)/g,red,1);
  }
  if(stopStart>=0){
    const source=text.slice(stopStart);
    colorMatches(source,stopStart,/Đã chi\s+([\d.]+)/g,red,1);
    colorMatches(source,stopStart,/ROI\s+[\d.,]+/g,red);
    colorMatches(source,stopStart,/mốc\s+([\d.,]+)/g,green,1);
  }
  return styles;
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
  const messageId = await sendMessage(env,text,undefined,buildAdsStyles(text));
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
  const event=payload?.result||payload||{};
  const message=event.message||event.edited_message||{};
  return {
    id:String(message.message_id||event.update_id||event.event_id||deepFind(event,['message_id'])||''),
    chatId:String(message.chat?.id||message.chat_id||event.chat_id||event.group_id||''),
    text:String(message.text||event.text||event.message_text||event.content||''),
    senderIsBot:Boolean(message.from?.is_bot??event.is_bot??event.sender_is_bot)
  };
}

export function extractZaloUpdates(payload:any):any[]{
  const value=payload?.result??payload;
  if(Array.isArray(value))return value;
  if(Array.isArray(value?.updates))return value.updates;
  return value&&typeof value==='object'?[value]:[];
}

export async function ensureZaloPollingMode(env:Env):Promise<void>{
  const cached=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_INBOX_MODE'").first<{value:string}>();
  if(cached?.value){try{const state=JSON.parse(cached.value);if(state.mode==='POLLING'&&Date.now()-Number(state.checkedAt)<300000)return;}catch{/* Refresh invalid state. */}}
  try{
    const info=await zaloApi(env,'getWebhookInfo',{}).catch(()=>({}));
    if(String(info?.url||''))await zaloApi(env,'deleteWebhook',{});
    await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_INBOX_MODE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
      .bind(JSON.stringify({mode:'POLLING',checkedAt:Date.now()})).run();
  }catch(error){
    await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_INBOX_MODE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
      .bind(JSON.stringify({mode:'ERROR',checkedAt:Date.now(),error:error instanceof Error?error.message:String(error)})).run();
    throw error;
  }
}

export async function pollZaloUpdates(env: Env): Promise<number> {
  await ensureZaloPollingMode(env);
  const pending=await env.DB.prepare("SELECT id FROM webhook_events WHERE provider='zalo' AND status='PENDING' ORDER BY id DESC LIMIT 1")
    .first<{id:number}>();
  if(pending){
    await env.TASK_QUEUE.send({type:'zalo-video',eventId:pending.id});
    await env.DB.prepare("UPDATE webhook_events SET status='QUEUED' WHERE id=? AND status='PENDING'").bind(pending.id).run();
    return 1;
  }
  let response:any;
  try{response=await zaloApi(env,'getUpdates',{timeout:'30'});}
  catch(error){
    const details=error instanceof Error?error.message:String(error);
    if(/408|request timeout/i.test(details))return 0;
    throw error;
  }
  let latest:any=null;
  for(const update of extractZaloUpdates(response)){
    const event=normalizeZaloEvent(update);
    if(event.id&&!event.senderIsBot&&(!env.ZALO_GROUP_CHAT_ID||event.chatId===env.ZALO_GROUP_CHAT_ID))latest=update;
  }
  if(!latest)return 0;
  const event=normalizeZaloEvent(latest);
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(provider,external_id,received_at,payload,status) VALUES('zalo',?,?,?,'PENDING')`)
    .bind(event.id||null,Date.now(),JSON.stringify(latest)).run();
  if(!result.meta.changes)return 0;
  const row=await env.DB.prepare('SELECT id FROM webhook_events WHERE provider=? AND external_id=? ORDER BY id DESC LIMIT 1')
    .bind('zalo',event.id).first<{id:number}>();
  if(row){
    await env.TASK_QUEUE.send({type:'zalo-video',eventId:row.id});
    await env.DB.prepare("UPDATE webhook_events SET status='QUEUED' WHERE id=? AND status='PENDING'").bind(row.id).run();
  }
  return row?1:0;
}

export async function processZaloVideo(env: Env, eventId: number): Promise<void> {
  const row = await env.DB.prepare('SELECT payload,status FROM webhook_events WHERE id=?').bind(eventId).first<{payload:string,status:string}>();
  if (!row||!['PENDING','QUEUED','RETRYING'].includes(row.status)) return;
  const claim=await env.DB.prepare("UPDATE webhook_events SET status='PROCESSING' WHERE id=? AND status IN ('PENDING','QUEUED','RETRYING')")
    .bind(eventId).run();
  if(!claim.meta.changes)return;
  const event=normalizeZaloEvent(JSON.parse(row.payload));
  if (event.senderIsBot || (env.ZALO_GROUP_CHAT_ID && event.chatId !== env.ZALO_GROUP_CHAT_ID)) {
    await env.DB.prepare("UPDATE webhook_events SET status='SKIPPED',result_json=?,processed_at=? WHERE id=?")
      .bind(JSON.stringify({reason:event.senderIsBot?'BOT_MESSAGE':'OTHER_CHAT'}),Date.now(),eventId).run();
    return;
  }
  const newer=await env.DB.prepare("SELECT id,payload FROM webhook_events WHERE provider='zalo' AND id>? AND status IN ('PENDING','QUEUED') ORDER BY id DESC LIMIT 20").bind(eventId).all<{id:number,payload:string}>();
  if(newer.results.some(item=>normalizeZaloEvent(JSON.parse(item.payload)).chatId===event.chatId)){
    await env.DB.prepare("UPDATE webhook_events SET status='SKIPPED',processed_at=? WHERE id=?").bind(Date.now(),eventId).run();return;
  }
  const match=event.text.match(/(?:tiktok\.com\/[^\s]*\/video\/|\b)(\d{19,30})(?:\b|[?/_])/i);
  if(!match){
    await sendMessage(env,'Định dạng link sai, vui lòng gửi lại định dạng: @Bot ADS - ALF https://www.tiktok.com/@username/video/POST_ID',event.chatId);
    await env.DB.prepare("UPDATE webhook_events SET status='DONE',result_json=?,processed_at=? WHERE id=?")
      .bind(JSON.stringify({reason:'INVALID_LINK'}),Date.now(),eventId).run();
    return;
  }
  const endDate=dateInTimezone(new Date(),env.TIMEZONE);const input={advertiserId:env.DEFAULT_ADVERTISER_ID,storeId:env.DEFAULT_STORE_CODE,itemId:match[1],endDate,metadataContexts:[],forceRefresh:false};
  const stats=await loadVideoStats(env,input);const totals=stats.daily.reduce((a:any,p:any)=>({cost:a.cost+p.cost,orders:a.orders+p.orders}),{cost:0,orders:0});
  const maxDailyOrders=Math.max(1,...stats.daily.map((point:any)=>Math.ceil(Number(point.orders)||0)));
  const chart={type:'line',data:{labels:stats.daily.map((p:any)=>p.date.slice(5)),datasets:[
    {label:'Cost',data:stats.daily.map((p:any)=>p.cost),borderColor:'#079d9b',pointRadius:2,yAxisID:'y'},
    {label:'SKU orders',data:stats.daily.map((p:any)=>p.orders),borderColor:'#ffad28',pointRadius:2,yAxisID:'y1'}]},options:{plugins:{legend:{position:'top'}},scales:{y:{position:'left'},y1:{position:'right',beginAtZero:true,max:maxDailyOrders,ticks:{stepSize:1},grid:{drawOnChartArea:false}}}}};
  await cachePut(env,`zalo-chart:${eventId}`,chart,3600);
  const chartUrl=`${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/charts/${eventId}.png`;
  const caption=`30D\nCost: ${integer(totals.cost)}\nGross revenue: ${integer(stats.video?.grossRevenue || 0)}\nCost per order: ${integer(totals.orders?totals.cost/totals.orders:0)}`;
  let delivery='PHOTO';
  try {
    await zaloApi(env,'sendPhoto',{chat_id:event.chatId||env.ZALO_GROUP_CHAT_ID,photo:chartUrl,caption});
  } catch (error) {
    delivery='TEXT_FALLBACK';
    const details=error instanceof Error?error.message:String(error);
    await sendMessage(env,`${caption}\n\nKhông gửi được ảnh biểu đồ: ${details}`,event.chatId);
  }
  await env.DB.prepare("UPDATE webhook_events SET status='DONE',result_json=?,processed_at=? WHERE id=?")
    .bind(JSON.stringify({itemId:match[1],delivery,cost:totals.cost,orders:totals.orders,grossRevenue:stats.video?.grossRevenue||0}),Date.now(),eventId).run();
}
