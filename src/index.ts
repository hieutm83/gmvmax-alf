import type { Env, TaskMessage } from './types';
import { OAuthCoordinator, createAuthorizationUrl, disconnect, getAccessToken, handleOAuthCallback, readTokens } from './oauth';
import { createSession, listAdvertisers, listStores } from './mcp';
import { loadComparison, loadCreativeSummaries, loadMainReport, loadProductVideos, loadVideoMetadata, loadVideoStats } from './reports';
import { backupDate } from './sheets';
import { extractDirectVideoId, extractZaloUpdates, finalizeZaloVideo, normalizeZaloEvent, processZaloVideo, processZaloVideoDay, recoverZaloVideoJobs, sendMessage, sendScheduledReport } from './zalo';
import { cacheGet, dateInTimezone, hourInTimezone, HttpError, json, readJson, shiftDate, validateDate, validateId } from './utils';

function ok(data: unknown): Response { return json({ ok: true, data }); }
function validateScope(input: any): any {
  return { ...input, advertiserId: validateId(input?.advertiserId, 'Advertiser ID'),
    storeId: String(input?.storeId || '').trim(), startDate: validateDate(input?.startDate, 'startDate'),
    endDate: validateDate(input?.endDate, 'endDate') };
}

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/api/state') {
    const tokens=await readTokens(env);let advertisers:any[]=[];let connectionError:string|undefined;
    if(tokens){try{advertisers=await listAdvertisers(env,await createSession(env));}catch(error){connectionError=error instanceof Error?error.message:String(error);}}
    const today=dateInTimezone(new Date(),env.TIMEZONE);return ok({connected:Boolean(tokens),startDate:today,endDate:today,
      defaultAdvertiserId:env.DEFAULT_ADVERTISER_ID,defaultStoreCode:env.DEFAULT_STORE_CODE,advertisers,connectionError});
  }
  if(request.method==='GET'&&url.pathname==='/api/oauth/connect')return ok(await createAuthorizationUrl(env,url.origin));
  if(request.method==='POST'&&url.pathname==='/api/oauth/disconnect'){await disconnect(env);return ok(true);}
  if(request.method==='POST'&&url.pathname==='/api/admin/verify'){const value=await readJson<any>(request);return ok(String(value||'')===env.ADMIN_PASSWORD);}
  if(request.method==='POST'&&url.pathname==='/api/stores'){const advertiserId=validateId(await readJson<any>(request),'Advertiser ID');return ok(await listStores(env,await createSession(env),advertiserId));}
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const input=await readJson<any>(request);
  if(url.pathname==='/api/report'){
    const scope=validateScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngay bat dau phai truoc ngay ket thuc.');
    const report=await loadMainReport(env,scope,input.forceRefresh===true);
    const today=dateInTimezone(new Date(),env.TIMEZONE);if(scope.startDate===scope.endDate&&scope.endDate<today){
      await env.DB.prepare(`INSERT INTO daily_metrics(advertiser_id,store_id,report_date,summary_json,products_json) VALUES(?,?,?,?,?)
        ON CONFLICT(advertiser_id,store_id,report_date) DO NOTHING`).bind(scope.advertiserId,scope.storeId,scope.endDate,JSON.stringify(report.totals),JSON.stringify(report.products)).run();
    }return ok(report);
  }
  if(url.pathname==='/api/product-videos')return ok(await loadProductVideos(env,validateScope(input)));
  if(url.pathname==='/api/creative-summaries')return ok(await loadCreativeSummaries(env,validateScope(input)));
  if(url.pathname==='/api/comparison')return ok(await loadComparison(env,{advertiserId:validateId(input.advertiserId,'Advertiser ID'),storeId:String(input.storeId),endDate:validateDate(input.endDate,'endDate')}));
  if(url.pathname==='/api/video-stats')return ok(await loadVideoStats(env,{...input,advertiserId:validateId(input.advertiserId,'Advertiser ID'),storeId:String(input.storeId),itemId:validateId(input.itemId,'Post ID'),endDate:validateDate(input.endDate,'endDate')}));
  if(url.pathname==='/api/video-metadata')return ok(await loadVideoMetadata(env,{...input,advertiserId:validateId(input.advertiserId,'Advertiser ID'),storeId:String(input.storeId),itemId:validateId(input.itemId,'Post ID'),endDate:validateDate(input.endDate,'endDate')}));
  throw new HttpError(404,'API route not found.');
}

function zaloRuntime(env:Env):Env{return {...env,
  DEFAULT_ADVERTISER_ID:env.ZALO_ADVERTISER_ID||env.DEFAULT_ADVERTISER_ID,
  DEFAULT_STORE_CODE:env.ZALO_STORE_ID||env.ZALO_STORE_CODE||env.DEFAULT_STORE_CODE} as Env;}

async function webhook(request: Request, env: Env, url: URL, ctx:ExecutionContext): Promise<Response> {
  const storedSecret=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_WEBHOOK_SECRET'").first<{value:string}>();
  const expectedSecret=storedSecret?.value||env.ZALO_WEBHOOK_SECRET;
  if(expectedSecret){const supplied=request.headers.get('x-webhook-secret')||url.searchParams.get('secret');
    const zaloSecret=request.headers.get('x-bot-api-secret-token');
    if(supplied!==expectedSecret&&zaloSecret!==expectedSecret)throw new HttpError(401,'Invalid webhook secret.');}
  const payload=await request.json<any>();const updates=extractZaloUpdates(payload);const event=normalizeZaloEvent(updates.at(-1)||payload);
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(provider,external_id,received_at,payload,status) VALUES('zalo',?,?,?,'PENDING')`)
    .bind(event.id||null,Date.now(),JSON.stringify(payload)).run();
  if(result.meta.changes){const row=await env.DB.prepare('SELECT id FROM webhook_events WHERE provider=? AND external_id IS ? ORDER BY id DESC LIMIT 1').bind('zalo',event.id||null).first<{id:number}>();
    if(row)ctx.waitUntil((async()=>{
      const itemId=extractDirectVideoId(event.text);
      if(itemId&&!event.senderIsBot&&(!env.ZALO_GROUP_CHAT_ID||event.chatId===env.ZALO_GROUP_CHAT_ID)){
        try{
          await sendMessage(env,`Đang xử lý dữ liệu 30 ngày cho video ${itemId}...`,event.chatId);
          await env.DB.prepare("UPDATE webhook_events SET result_json=? WHERE id=? AND status='PENDING'")
            .bind(JSON.stringify({acknowledged:true,itemId}),row.id).run();
        }catch(error){console.error('Immediate Zalo acknowledgement failed',error instanceof Error?error.message:String(error));}
      }
      await env.ZALO_INBOX_QUEUE.send({type:'zalo-video',eventId:row.id},{delaySeconds:2});
      await env.DB.prepare("UPDATE webhook_events SET status='QUEUED' WHERE id=? AND status='PENDING'").bind(row.id).run();
    })());}
  return json({ok:true});
}

async function resolveDefaultStore(env:Env):Promise<string>{
  const stores=await listStores(env,await createSession(env),env.DEFAULT_ADVERTISER_ID);
  return stores.find((s:any)=>s.storeCode===env.DEFAULT_STORE_CODE||s.storeId===env.DEFAULT_STORE_CODE)?.storeId||env.DEFAULT_STORE_CODE;
}

async function consume(message: TaskMessage, env: Env): Promise<void> {
  const runtime=zaloRuntime(env);
  if(message.type==='zalo-poll'||message.type==='zalo-webhook-ensure')return;
  if(message.type==='zalo-video'||message.type==='zalo-video-day'||message.type==='zalo-video-finalize'||message.type==='zalo-video-recover')return;
  if(message.type==='hourly-dispatch'){
    try{await getAccessToken(runtime);}catch(error){console.error('TikTok OAuth refresh failed',error instanceof Error?error.message:String(error));return;}
    const tasks:Promise<unknown>[]=[];
    if(message.backupDate&&env.GOOGLE_BACKUP_SPREADSHEET_ID)tasks.push(env.TASK_QUEUE.send({type:'sheet-backup',reportDate:message.backupDate}));
    if(env.ZALO_BOT_TOKEN&&env.ZALO_GROUP_CHAT_ID)tasks.push(env.TASK_QUEUE.send({type:'scheduled-report',reportDate:message.reportDate,reportHour:message.reportHour}));
    await Promise.all(tasks);return;
  }
  if(message.type==='sheet-backup'){
    const storeId=await resolveDefaultStore(runtime);const report=await loadMainReport(runtime,{advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate},true);
    const summary=await loadCreativeSummaries(runtime,{advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate,products:report.products,allContexts:report.creativeContexts,availableProducts:report.availableProductCount,forceRefresh:true});
    await env.DB.prepare(`INSERT INTO daily_metrics(advertiser_id,store_id,report_date,summary_json,products_json,creatives_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(advertiser_id,store_id,report_date) DO NOTHING`).bind(runtime.DEFAULT_ADVERTISER_ID,storeId,message.reportDate,JSON.stringify(report.totals),JSON.stringify(report.products),JSON.stringify(summary)).run();
    return backupDate(env,message.reportDate);
  }
  const storeId=await resolveDefaultStore(runtime);
  await sendScheduledReport({...runtime,DEFAULT_STORE_CODE:storeId},message.reportDate,message.reportHour);
}

async function assetResponse(request:Request,env:Env):Promise<Response>{
  const assetUrl=new URL(request.url);
  const isHtml=assetUrl.pathname==='/'||assetUrl.pathname.endsWith('.html');
  if(isHtml)assetUrl.searchParams.set('__asset_version','20260729-utf8');
  const response=await env.ASSETS.fetch(new Request(assetUrl.toString(),request));
  const headers=new Headers(response.headers);
  if(isHtml){headers.set('Content-Type','text/html; charset=UTF-8');headers.set('Cache-Control','no-store');}
  if(assetUrl.pathname.endsWith('.js'))headers.set('Content-Type','application/javascript; charset=UTF-8');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

async function chartImage(env:Env,id:string):Promise<Response>{
  if(!/^\d+$/.test(id))throw new HttpError(400,'Invalid chart ID.');
  const chart=await cacheGet<any>(env,`zalo-chart:${id}`);
  if(!chart)throw new HttpError(404,'Chart expired.');
  const response=await fetch('https://quickchart.io/chart',{
    method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},
    body:JSON.stringify({chart,width:1000,height:520,format:'png',backgroundColor:'white',version:'4'})
  });
  if(!response.ok)throw new HttpError(502,'Chart service failed.');
  return new Response(response.body,{headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=3600','Content-Disposition':`inline; filename="video-${id}.png"`}});
}

export { OAuthCoordinator };

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url);
    try{
      if(url.pathname==='/oauth/callback')return handleOAuthCallback(env,url);
      if(url.pathname==='/webhooks/zalo'&&request.method==='POST')return json({ok:false,error:'Zalo interactive messages are disabled.'},410);
      const chartMatch=url.pathname.match(/^\/charts\/(\d+)\.png$/);
      if(chartMatch&&request.method==='GET')return chartImage(env,chartMatch[1]);
      if(url.pathname.startsWith('/api/'))return routeApi(request,env,url);
      return assetResponse(request,env);
    }catch(error){const status=error instanceof HttpError?error.status:500;return json({ok:false,error:error instanceof Error?error.message:String(error)},status);}
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    const now=new Date();const localHour=hourInTimezone(now,env.TIMEZONE);const localDate=dateInTimezone(now,env.TIMEZONE);
    if(now.getUTCMinutes()!==0)return;
    const reportHour=localHour===0?24:localHour;
    const reportDate=localHour===0?shiftDate(localDate,-1):localDate;
    ctx.waitUntil(env.TASK_QUEUE.send({type:'hourly-dispatch',reportDate,reportHour,
      backupDate:localHour===8?shiftDate(localDate,-1):undefined}));
  },
  async queue(batch:MessageBatch<TaskMessage>,env:Env):Promise<void>{
    for(const message of batch.messages){
      try{await consume(message.body,env);message.ack();}
      catch(error){
        const details=error instanceof Error?error.message:String(error);
        console.error('Queue task failed',message.body,details);
        if(message.body.type==='zalo-video'){
          await env.DB.prepare("UPDATE webhook_events SET status='RETRYING',result_json=? WHERE id=?")
            .bind(JSON.stringify({error:details}),message.body.eventId).run();
        }
        message.retry({delaySeconds:10});
      }
    }
  }
} satisfies ExportedHandler<Env,TaskMessage>;
