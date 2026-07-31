import type { Env } from './types';
import { discoverVideoContexts, loadCreativeSummaries, loadMainReport, loadVideoDayStats } from './reports';
import { cachePut, dateInTimezone, shiftDate } from './utils';

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
  add(0,titleEnd<0?text.length:titleEnd,'f_15','i');
  const bodyStart=titleEnd<0?text.length:titleEnd+1;
  add(bodyStart,text.length-bodyStart,'f_13');

  for(const label of ['Cost:','SKU orders:','Cost / order:','Gross revenue:','ROI:']){
    const start=text.indexOf(label);
    add(start,label.length,'u','b');
  }

  const colorTrend=(label:string,increaseIsGood:boolean)=>{
    const start=text.indexOf(label);if(start<0)return;
    const end=text.indexOf('\n',start);const line=text.slice(start,end<0?text.length:end);
    const match=line.match(/[↑↓]\s*[\d.,]+%/);if(!match)return;
    const good=match[0].startsWith('↑')?increaseIsGood:!increaseIsGood;
    add(start+(match.index||0),match[0].length,good?green:red);
  };
  colorTrend('Cost:',false);colorTrend('Gross revenue:',true);colorTrend('Cost / order:',false);

  const boostStart=text.indexOf('- Boost:');const stopStart=text.indexOf('- Tắt:');
  add(boostStart,'- Boost:'.length,green,'u','b');add(stopStart,'- Tắt:'.length,red,'u','b');
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
  const cumulative = report.hourlyMode === 'cumulative';
  const t = cumulative ? report.totals : hourlyRow.metrics;
  let text = [
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
  if (cumulative) text = text.replace(':00\n', ':00 (lũy kế)\n');
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

export function zaloUpdateTimestamp(payload:any):number{
  const event=payload?.result||payload||{};const message=event.message||event.edited_message||{};
  return Number(message.date||message.timestamp||event.date||event.timestamp||event.created_at)||0;
}

export function extractDirectVideoId(text:string):string|null{
  return text.match(/(?:tiktok\.com\/[^\s]*\/video\/|\b)(\d{19,30})(?:\b|[?/_])/i)?.[1]||null;
}

async function extractVideoId(text:string):Promise<string|null>{
  const direct=extractDirectVideoId(text);if(direct)return direct;
  const short=text.match(/https?:\/\/(?:www\.)?(?:vt|vm)\.tiktok\.com\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/,'');
  if(!short)return null;
  let current=short;
  for(let hop=0;hop<5;hop+=1){
    const response=await fetch(current,{redirect:'manual',headers:{'User-Agent':'Mozilla/5.0'}});
    const location=response.headers.get('location');
    if(!location)return extractDirectVideoId(response.url);
    current=new URL(location,current).toString();const id=extractDirectVideoId(current);if(id)return id;
  }
  return null;
}

export async function ensureZaloWebhook(env:Env):Promise<void>{
  const cached=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_INBOX_MODE'").first<{value:string}>();
  if(cached?.value){try{const state=JSON.parse(cached.value);if(state.mode==='WEBHOOK'&&Date.now()-Number(state.checkedAt)<300000)return;}catch{/* Refresh invalid state. */}}
  try{
    let secret=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_WEBHOOK_SECRET'").first<{value:string}>();
    if(!secret?.value){
      const value=`cfwh_${crypto.randomUUID().replace(/-/g,'')}`;
      await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_WEBHOOK_SECRET',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(value).run();
      secret={value};
    }
    const url=`${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/webhooks/zalo`;
    const info=await zaloApi(env,'getWebhookInfo',{}).catch(()=>({}));
    if(String(info?.url||'')!==url)await zaloApi(env,'setWebhook',{url,secret_token:secret.value});
    await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_INBOX_MODE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
      .bind(JSON.stringify({mode:'WEBHOOK',url,checkedAt:Date.now()})).run();
  }catch(error){
    await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_INBOX_MODE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
      .bind(JSON.stringify({mode:'ERROR',checkedAt:Date.now(),error:error instanceof Error?error.message:String(error)})).run();
    throw error;
  }
}

export async function processZaloVideo(env: Env, eventId: number): Promise<void> {
  const row = await env.DB.prepare('SELECT payload,status,result_json FROM webhook_events WHERE id=?').bind(eventId).first<{payload:string;status:string;result_json:string|null}>();
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
  const itemId=await extractVideoId(event.text);
  if(!itemId){
    await sendMessage(env,'Định dạng link sai, vui lòng gửi lại định dạng: @Bot ADS - ALF https://www.tiktok.com/@username/video/POST_ID',event.chatId);
    await env.DB.prepare("UPDATE webhook_events SET status='DONE',result_json=?,processed_at=? WHERE id=?")
      .bind(JSON.stringify({reason:'INVALID_LINK'}),Date.now(),eventId).run();
    return;
  }
  let acknowledged=false;
  try{acknowledged=Boolean(row.result_json&&JSON.parse(row.result_json)?.acknowledged);}catch{/* Invalid prior result. */}
  if(!acknowledged)await sendMessage(env,`Đang xử lý dữ liệu 30 ngày cho video ${itemId}...`,event.chatId);
  const endDate=dateInTimezone(new Date(),env.TIMEZONE),startDate=shiftDate(endDate,-29);
  const input={advertiserId:env.DEFAULT_ADVERTISER_ID,storeId:env.DEFAULT_STORE_CODE,itemId,metadataContexts:[]};
  const cachedJob=await env.DB.prepare(`SELECT contexts_json FROM video_jobs WHERE item_id=? AND advertiser_id=? AND store_id=?
    AND status='DONE' AND updated_at >= datetime('now','-1 day') ORDER BY updated_at DESC LIMIT 1`)
    .bind(itemId,input.advertiserId,input.storeId).first<{contexts_json:string}>();
  const contexts=cachedJob?.contexts_json?JSON.parse(cachedJob.contexts_json):await discoverVideoContexts(env,input,startDate,endDate);
  if(!contexts.length)throw new Error('Không tìm thấy campaign có dữ liệu cho video.');
  await env.DB.prepare(`INSERT INTO video_jobs(event_id,item_id,advertiser_id,store_id,start_date,end_date,contexts_json,status)
    VALUES(?,?,?,?,?,?,?,'RUNNING') ON CONFLICT(event_id) DO UPDATE SET contexts_json=excluded.contexts_json,status='RUNNING',updated_at=CURRENT_TIMESTAMP`)
    .bind(eventId,itemId,input.advertiserId,input.storeId,startDate,endDate,JSON.stringify(contexts)).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO video_job_days(event_id,report_date,metrics_json)
    SELECT ?,d.report_date,d.metrics_json FROM video_job_days d JOIN video_jobs j ON j.event_id=d.event_id
    WHERE j.item_id=? AND j.advertiser_id=? AND j.store_id=? AND d.report_date>=? AND d.report_date<? AND d.event_id<>?`)
    .bind(eventId,itemId,input.advertiserId,input.storeId,startDate,endDate,eventId).run();
  const cachedDays=await env.DB.prepare('SELECT report_date FROM video_job_days WHERE event_id=?').bind(eventId).all<{report_date:string}>();
  const completed=new Set(cachedDays.results.map(day=>day.report_date));
  const dates=Array.from({length:30},(_,index)=>shiftDate(startDate,index)).filter(date=>!completed.has(date));
  if(dates.length)await env.TASK_QUEUE.sendBatch(dates.map(reportDate=>({body:{type:'zalo-video-day' as const,eventId,reportDate}})));
  else await env.TASK_QUEUE.send({type:'zalo-video-finalize',eventId});
}

export async function processZaloVideoDay(env:Env,eventId:number,reportDate:string):Promise<void>{
  const job=await env.DB.prepare("SELECT item_id,advertiser_id,store_id,contexts_json,status FROM video_jobs WHERE event_id=?")
    .bind(eventId).first<{item_id:string;advertiser_id:string;store_id:string;contexts_json:string;status:string}>();
  if(!job||job.status==='DONE')return;
  const point=await loadVideoDayStats(env,{advertiserId:job.advertiser_id,storeId:job.store_id,itemId:job.item_id},JSON.parse(job.contexts_json),reportDate);
  await env.DB.prepare("INSERT OR IGNORE INTO video_job_days(event_id,report_date,metrics_json) VALUES(?,?,?)")
    .bind(eventId,reportDate,JSON.stringify(point)).run();
  await env.DB.prepare("UPDATE video_jobs SET updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND status='RUNNING'").bind(eventId).run();
  const count=await env.DB.prepare("SELECT COUNT(*) AS total FROM video_job_days WHERE event_id=?").bind(eventId).first<{total:number}>();
  if(Number(count?.total)<30)return;
  const claim=await env.DB.prepare("UPDATE video_jobs SET status='FINALIZING',updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND status='RUNNING'")
    .bind(eventId).run();
  if(claim.meta.changes)await env.TASK_QUEUE.send({type:'zalo-video-finalize',eventId});
}

export async function recoverZaloVideoJobs(env:Env):Promise<void>{
  const jobs=await env.DB.prepare(`SELECT event_id,start_date,end_date,status FROM video_jobs
    WHERE status IN ('RUNNING','FINALIZING') AND updated_at < datetime('now','-2 minutes') ORDER BY updated_at LIMIT 5`)
    .all<{event_id:number;start_date:string;end_date:string;status:string}>();
  for(const job of jobs.results){
    const existing=await env.DB.prepare('SELECT report_date FROM video_job_days WHERE event_id=?').bind(job.event_id).all<{report_date:string}>();
    const completed=new Set(existing.results.map(row=>row.report_date));
    const dates:string[]=[];
    for(let date=job.start_date;date<=job.end_date;date=shiftDate(date,1))if(!completed.has(date))dates.push(date);
    if(dates.length){
      await env.DB.prepare("UPDATE video_jobs SET status='RUNNING',updated_at=CURRENT_TIMESTAMP WHERE event_id=?").bind(job.event_id).run();
      await env.TASK_QUEUE.sendBatch(dates.map(reportDate=>({body:{type:'zalo-video-day' as const,eventId:job.event_id,reportDate}})));
    }else{
      await env.DB.prepare("UPDATE video_jobs SET status='FINALIZING',updated_at=CURRENT_TIMESTAMP WHERE event_id=?").bind(job.event_id).run();
      await env.TASK_QUEUE.send({type:'zalo-video-finalize',eventId:job.event_id});
    }
  }
}

export async function finalizeZaloVideo(env:Env,eventId:number):Promise<void>{
  const job=await env.DB.prepare("SELECT item_id,status FROM video_jobs WHERE event_id=?").bind(eventId).first<{item_id:string;status:string}>();
  if(!job||job.status==='DONE')return;
  const row=await env.DB.prepare("SELECT payload FROM webhook_events WHERE id=?").bind(eventId).first<{payload:string}>();
  if(!row)throw new Error('Không tìm thấy sự kiện Zalo của video.');
  const days=await env.DB.prepare("SELECT metrics_json FROM video_job_days WHERE event_id=? ORDER BY report_date").bind(eventId).all<{metrics_json:string}>();
  if(days.results.length<30)throw new Error(`Video mới hoàn thành ${days.results.length}/30 ngày.`);
  const event=normalizeZaloEvent(JSON.parse(row.payload)),daily=days.results.map(day=>JSON.parse(day.metrics_json));
  const totals=daily.reduce((sum:any,point:any)=>({cost:sum.cost+Number(point.cost||0),orders:sum.orders+Number(point.orders||0),grossRevenue:sum.grossRevenue+Number(point.grossRevenue||0)}),{cost:0,orders:0,grossRevenue:0});
  const maxDailyOrders=Math.max(0,...daily.map((point:any)=>Math.ceil(Number(point.orders)||0)))+5;
  const chart={type:'line',data:{labels:daily.map((p:any)=>p.date.slice(5)),datasets:[
    {label:'Cost',data:daily.map((p:any)=>p.cost),borderColor:'#079d9b',pointRadius:2,yAxisID:'y'},
    {label:'SKU orders',data:daily.map((p:any)=>p.orders),borderColor:'#ffad28',pointRadius:2,yAxisID:'y1'}]},options:{plugins:{legend:{position:'top'}},scales:{y:{position:'left'},y1:{position:'right',beginAtZero:true,max:maxDailyOrders,ticks:{stepSize:1},grid:{drawOnChartArea:false}}}}};
  await cachePut(env,`zalo-chart:${eventId}`,chart,3600);
  const chartUrl=`${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/charts/${eventId}.png`;
  const caption=`30D\nCost: ${integer(totals.cost)}\nGross revenue: ${integer(totals.grossRevenue)}\nCost per order: ${integer(totals.orders?totals.cost/totals.orders:0)}`;
  let delivery='PHOTO';
  try{await zaloApi(env,'sendPhoto',{chat_id:event.chatId||env.ZALO_GROUP_CHAT_ID,photo:chartUrl,caption});}
  catch(error){delivery='TEXT_FALLBACK';const details=error instanceof Error?error.message:String(error);await sendMessage(env,`${caption}\n\nKhông gửi được ảnh biểu đồ: ${details}`,event.chatId);}
  await env.DB.prepare("UPDATE webhook_events SET status='DONE',result_json=?,processed_at=? WHERE id=?")
    .bind(JSON.stringify({itemId:job.item_id,delivery,cost:totals.cost,orders:totals.orders,grossRevenue:totals.grossRevenue}),Date.now(),eventId).run();
  await env.DB.prepare("UPDATE video_jobs SET status='DONE',updated_at=CURRENT_TIMESTAMP WHERE event_id=?").bind(eventId).run();
}
