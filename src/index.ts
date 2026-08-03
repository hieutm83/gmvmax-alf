import type { Env, TaskMessage } from './types';
import { OAuthCoordinator, createAuthorizationUrl, disconnect, getAccessToken, handleOAuthCallback, readTokens } from './oauth';
import { createSession, listAdvertisers, listStores, resolveDefaultStoreId } from './mcp';
import { loadComparison, loadCreativeSummaries, loadMainReport, loadProductVideos, loadVideoMetadata, loadVideoStats } from './reports';
import { backupDate } from './sheets';
import { createSellerAuthorizationUrl, disconnectSeller, handleSellerOAuthCallback, loadSellerRevenueAnalysis, sellerOAuthState } from './seller';
import { loadOperationsAnalysis, syncTrackingOrder } from './operations';
import { loadFinanceAnalysis, loadFinancePeriodSummary, loadSkuUnitCosts, saveSkuUnitCost } from './finance';
import { loadContentKocAnalysis } from './content-koc';
import { loadProductAnalysis } from './product-analysis';
import { extractDirectVideoId, extractZaloUpdates, finalizeZaloVideo, normalizeZaloEvent, processZaloVideo, processZaloVideoDay, recoverZaloVideoJobs, sendMessage, sendScheduledReport } from './zalo';
import { pollOperationsBot, prepareMonthlyOperationsReport, prepareWeeklyOperationsReport, sendOperationsReport, sendWeeklyOperationsReport } from './operations-bot';
import { monitorOrderBot, ORDER_BOT_SLOTS, sendOrderBotReport } from './order-bot';
import { cacheGet, dateInTimezone, hourInTimezone, HttpError, json, readJson, shiftDate, validateDate, validateId } from './utils';
import { assertDashboardApiAccess, assertDashboardLoginAllowed, clearDashboardLoginFailures, clearDashboardSessionCookie,
  createDashboardSession, dashboardRoleForPassword, dashboardSessionCookie, dashboardSessionFromRequest,
  recordDashboardLoginFailure, type DashboardRole, type DashboardSession } from './dashboard-auth';

function ok(data: unknown): Response { return json({ ok: true, data }); }
function validateScope(input: any): any {
  return { ...input, advertiserId: validateId(input?.advertiserId, 'Advertiser ID'),
    storeId: String(input?.storeId || '').trim(), startDate: validateDate(input?.startDate, 'startDate'),
    endDate: validateDate(input?.endDate, 'endDate') };
}

function validateSellerScope(input: any): any {
  return {
    startDate: validateDate(input?.startDate, 'startDate'),
    endDate: validateDate(input?.endDate, 'endDate'),
    forceRefresh: input?.forceRefresh === true,
  };
}

async function routeApi(request: Request, env: Env, url: URL, session: DashboardSession): Promise<Response> {
  assertDashboardApiAccess(session.role, url.pathname, request.method);
  if (request.method === 'GET' && url.pathname === '/api/state') {
    const tokens=await readTokens(env);let advertisers:any[]=[];let connectionError:string|undefined;
    if(tokens){try{advertisers=await listAdvertisers(env,await createSession(env));}catch(error){connectionError=error instanceof Error?error.message:String(error);}}
    const today=dateInTimezone(new Date(),env.TIMEZONE);return ok({connected:Boolean(tokens),startDate:today,endDate:today,
      adsOAuth:{connected:Boolean(tokens),expiresAt:tokens?.expiresAt||null,scope:tokens?.scope||env.MCP_SCOPE,storage:'Encrypted D1'},
      sellerOAuth:await sellerOAuthState(env),
      dashboardRole:session.role,
      defaultAdvertiserId:env.DEFAULT_ADVERTISER_ID,defaultStoreCode:env.DEFAULT_STORE_CODE,advertisers,connectionError});
  }
  if(request.method==='GET'&&url.pathname==='/api/oauth/connect')return ok(await createAuthorizationUrl(env,url.origin));
  if(request.method==='GET'&&url.pathname==='/api/finance-sku-cost')return ok(await loadSkuUnitCosts(env));
  if(request.method==='POST'&&url.pathname==='/api/oauth/disconnect'){await disconnect(env);return ok(true);}
  if(request.method==='POST'&&url.pathname==='/api/seller/disconnect'){await disconnectSeller(env);return ok(true);}
  if(request.method==='POST'&&url.pathname==='/api/admin/verify'){const value=await readJson<any>(request);return ok(String(value||'')===env.ADMIN_PASSWORD);}
  if(request.method==='POST'&&url.pathname==='/api/stores'){const advertiserId=validateId(await readJson<any>(request),'Advertiser ID');return ok(await listStores(env,await createSession(env),advertiserId));}
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const rawInput=await readJson<any>(request);
  const input=session.role==='content'
    ? {...rawInput,startDate:dateInTimezone(new Date(),env.TIMEZONE),endDate:dateInTimezone(new Date(),env.TIMEZONE)}
    : rawInput;
  if(url.pathname==='/api/report'){
    const scope=validateScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngay bat dau phai truoc ngay ket thuc.');
    const report=await loadMainReport(env,scope,input.forceRefresh===true);
    const today=dateInTimezone(new Date(),env.TIMEZONE);if(scope.startDate===scope.endDate&&scope.endDate<today){
      await env.DB.prepare(`INSERT INTO daily_metrics(advertiser_id,store_id,report_date,summary_json,products_json) VALUES(?,?,?,?,?)
        ON CONFLICT(advertiser_id,store_id,report_date) DO NOTHING`).bind(scope.advertiserId,scope.storeId,scope.endDate,JSON.stringify(report.totals),JSON.stringify(report.products)).run();
    }return ok(report);
  }
  if(url.pathname==='/api/revenue-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngay bat dau phai truoc ngay ket thuc.');
    return ok(await loadSellerRevenueAnalysis(env,scope));
  }
  if(url.pathname==='/api/content-koc-analysis'){
    const scope=validateScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadContentKocAnalysis(env,{...scope,forceRefresh:input.forceRefresh===true}));
  }
  if(url.pathname==='/api/product-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadProductAnalysis(env,scope));
  }
  if(url.pathname==='/api/operations-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadOperationsAnalysis(env,scope));
  }
  if(url.pathname==='/api/finance-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadFinanceAnalysis(env,scope));
  }
  if(url.pathname==='/api/finance-period-summary'){
    const baseScope=validateSellerScope(input);if(baseScope.startDate>baseScope.endDate)throw new HttpError(400,'NgÃ y báº¯t Ä‘áº§u pháº£i trÆ°á»›c ngÃ y káº¿t thÃºc.');
    const scope={...baseScope,
      statementStartDate:input.statementStartDate?validateDate(input.statementStartDate,'statementStartDate'):undefined,
      statementEndDate:input.statementEndDate?validateDate(input.statementEndDate,'statementEndDate'):undefined,
      includeUnsettled:input.includeUnsettled!==false};
    return ok(await loadFinancePeriodSummary(env,scope));
  }
  if(url.pathname==='/api/finance-sku-cost')return ok(await saveSkuUnitCost(env,input));
  if(url.pathname==='/api/product-videos')return ok(await loadProductVideos(env,validateScope(input)));
  if(url.pathname==='/api/creative-summaries')return ok(await loadCreativeSummaries(env,validateScope(input)));
  if(url.pathname==='/api/comparison')return ok(await loadComparison(env,{advertiserId:validateId(input.advertiserId,'Advertiser ID'),storeId:String(input.storeId),startDate:validateDate(input.startDate||input.endDate,'startDate'),endDate:validateDate(input.endDate,'endDate')}));
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

async function tiktokShopWebhook(request: Request, env: Env): Promise<Response> {
  if(request.method==='GET'||request.method==='HEAD'||request.method==='OPTIONS')return new Response(request.method==='HEAD'?null:'OK',{status:200});
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const payload=await request.json<any>().catch(()=>null);
  if(!payload)return new Response('OK',{status:200});
  if(payload.challenge)return json({challenge:payload.challenge});
  const externalId=String(payload.event_id||payload.id||payload.request_id||'').trim()||null;
  await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(provider,external_id,received_at,payload,status)
    VALUES('tiktok-shop',?,?,?,'RECEIVED')`).bind(externalId,Date.now(),JSON.stringify(payload)).run();
  return json({ok:true});
}

async function resolveDefaultStore(env:Env):Promise<string>{
  return resolveDefaultStoreId(env);
}

async function pollOperationsInbox(env:Env):Promise<void>{
  if(!env.ZALO_OPERATIONS_BOT_TOKEN||!env.ZALO_OPERATIONS_GROUP_CHAT_ID)return;
  const updates=await pollOperationsBot(env,25);
  const candidates=updates.filter((update)=>!update.senderIsBot&&update.chatId===env.ZALO_OPERATIONS_GROUP_CHAT_ID&&/\bcheck\b/i.test(update.text));
  const latest=candidates.sort((a,b)=>(a.timestamp-b.timestamp)||a.id.localeCompare(b.id)).at(-1);
  if(!latest)return;
  const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO operations_bot_events(external_id,chat_id,received_at,status)
    VALUES(?,?,?,'QUEUED')`).bind(latest.id,latest.chatId,Date.now()).run();
  if(inserted.meta.changes)await env.TASK_QUEUE.send({type:'operations-daily-report',reportDate:dateInTimezone(new Date(),env.TIMEZONE),mode:'REALTIME',chatId:latest.chatId,eventId:latest.id});
}

async function consume(message: TaskMessage, env: Env): Promise<void> {
  const runtime=zaloRuntime(env);
  if(message.type==='tracking-sync')return syncTrackingOrder(env,message.orderId,message.shopCipher);
  if(message.type==='zalo-poll'||message.type==='zalo-webhook-ensure')return;
  if(message.type==='zalo-video'||message.type==='zalo-video-day'||message.type==='zalo-video-finalize'||message.type==='zalo-video-recover')return;
  if(message.type==='hourly-dispatch'){
    try{await getAccessToken(runtime);}catch(error){console.error('TikTok OAuth refresh failed',error instanceof Error?error.message:String(error));return;}
    const tasks:Promise<unknown>[]=[];
    if(message.backupDate&&env.GOOGLE_BACKUP_SPREADSHEET_ID)tasks.push(env.TASK_QUEUE.send({type:'sheet-backup',reportDate:message.backupDate}));
    if(env.ZALO_BOT_TOKEN&&env.ZALO_GROUP_CHAT_ID)tasks.push(env.TASK_QUEUE.send({type:'scheduled-report',reportDate:message.reportDate,reportHour:message.reportHour},message.reportHour===8?{delaySeconds:30}:undefined));
    await Promise.all(tasks);return;
  }
  if(message.type==='operations-daily-report'){
    const storeId=env.ZALO_STORE_ID||await resolveDefaultStore(runtime);
    await sendOperationsReport({...runtime,DEFAULT_STORE_CODE:storeId},message.reportDate,message.mode,message.chatId,message.operationsDate||message.reportDate);
    if(message.eventId)await env.DB.prepare("UPDATE operations_bot_events SET status='DONE',processed_at=? WHERE external_id=?")
      .bind(Date.now(),message.eventId).run();
    return;
  }
  if(message.type==='operations-weekly-report')return sendWeeklyOperationsReport(env,message.saturdayDate);
  if(message.type==='operations-weekly-prepare')return prepareWeeklyOperationsReport(zaloRuntime(env),message.saturdayDate,message.stage);
  if(message.type==='operations-monthly-prepare')return prepareMonthlyOperationsReport(zaloRuntime(env),message.firstDayOfMonth,message.stage);
  if(message.type==='order-bot-report')return sendOrderBotReport(env,message.reportDate,message.reportTime,message.force===true);
  if(message.type==='order-bot-monitor')return monitorOrderBot(env,message.reportDate);
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
  if(assetUrl.pathname==='/login')assetUrl.pathname='/login.html';
  const reportPaths=new Set(['/doanh-thu','/quang-cao','/hoan-huy-logistics','/tai-chinh','/content-koc']);
  if(reportPaths.has(assetUrl.pathname)){assetUrl.pathname='/';return Response.redirect(assetUrl.toString(),302);}
  const isHtml=assetUrl.pathname==='/'||assetUrl.pathname.endsWith('.html');
  if(isHtml)assetUrl.searchParams.set('__asset_version','20260729-utf8');
  const response=await env.ASSETS.fetch(new Request(assetUrl.toString(),request));
  const headers=new Headers(response.headers);
  if(isHtml){headers.set('Content-Type','text/html; charset=UTF-8');headers.set('Cache-Control','no-store');}
  if(assetUrl.pathname.endsWith('.js'))headers.set('Content-Type','application/javascript; charset=UTF-8');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

async function dashboardLogin(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const fingerprint=await assertDashboardLoginAllowed(request,env);
  const input=await readJson<{password?:string}>(request);
  const role=await dashboardRoleForPassword(env,String(input?.password||''));
  if(!role){await recordDashboardLoginFailure(env,fingerprint);throw new HttpError(401,'Mã khóa không đúng.');}
  await clearDashboardLoginFailures(env,fingerprint);
  const token=await createDashboardSession(env,role);
  return new Response(JSON.stringify({ok:true,data:{role}}),{status:200,headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Set-Cookie':dashboardSessionCookie(token)
  }});
}

function dashboardLogout():Response{
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Set-Cookie':clearDashboardSessionCookie()
  }});
}

function dashboardLoginRedirect(url:URL):Response{
  const login=new URL('/login',url.origin);
  login.searchParams.set('next',`${url.pathname}${url.search}`);
  return Response.redirect(login.toString(),302);
}

function requireAdminRole(role:DashboardRole):void{
  if(role!=='admin')throw new HttpError(403,'Chỉ quản trị viên được thực hiện thao tác này.');
}

async function operationsBotWebhook(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const supplied=request.headers.get('x-bot-api-secret-token')||request.headers.get('x-webhook-secret');
  if(env.ZALO_OPERATIONS_WEBHOOK_SECRET&&supplied!==env.ZALO_OPERATIONS_WEBHOOK_SECRET)throw new HttpError(401,'Invalid operations bot webhook secret.');
  const payload=await request.json<any>();
  const event=normalizeZaloEvent(payload);
  if(event.senderIsBot||event.chatId!==env.ZALO_OPERATIONS_GROUP_CHAT_ID||!/\bcheck\b/i.test(event.text))return json({ok:true,ignored:true});
  const rawId=event.id||Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))))
    .map((value)=>value.toString(16).padStart(2,'0')).join('');
  const result=await env.DB.prepare("INSERT OR IGNORE INTO operations_bot_events(external_id,chat_id,received_at,status) VALUES(?,?,?,'QUEUED')")
    .bind(rawId,event.chatId,Date.now()).run();
  if(result.meta.changes)ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-daily-report',reportDate:dateInTimezone(new Date(),env.TIMEZONE),mode:'REALTIME',chatId:event.chatId,eventId:rawId}));
  return json({ok:true,queued:Boolean(result.meta.changes)});
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
      if(url.pathname==='/tiktok/webhook')return await tiktokShopWebhook(request,env);
      if(url.pathname==='/webhooks/zalo-operations'&&request.method==='POST')return operationsBotWebhook(request,env,ctx);
      if(url.pathname==='/webhooks/zalo'&&request.method==='POST')return json({ok:false,error:'Zalo interactive messages are disabled.'},410);
      const chartMatch=url.pathname.match(/^\/charts\/(\d+)\.png$/);
      if(chartMatch&&request.method==='GET')return chartImage(env,chartMatch[1]);
      if(url.pathname==='/auth/login')return dashboardLogin(request,env);
      if(url.pathname==='/login'&&request.method==='GET')return assetResponse(request,env);
      if(url.pathname==='/FAVICON.png'&&request.method==='GET')return assetResponse(request,env);

      const session=await dashboardSessionFromRequest(request,env);
      if(!session){
        if(url.pathname.startsWith('/api/')||request.method!=='GET')throw new HttpError(401,'Phiên đăng nhập đã hết hạn.');
        return dashboardLoginRedirect(url);
      }
      if(url.pathname==='/auth/logout')return dashboardLogout();
      if(url.pathname==='/auth/connect'&&request.method==='GET'){requireAdminRole(session.role);return Response.redirect(await createAuthorizationUrl(env,url.origin),302);}
      if(url.pathname==='/auth/callback'){
        requireAdminRole(session.role);
        if(url.searchParams.has('app_key'))return handleSellerOAuthCallback(env,url);
        return handleOAuthCallback(env,url);
      }
      if(url.pathname==='/oauth/callback'){requireAdminRole(session.role);return handleOAuthCallback(env,url);}
      if(url.pathname==='/seller/auth/connect'&&request.method==='GET'){requireAdminRole(session.role);return Response.redirect(await createSellerAuthorizationUrl(env),302);}
      if(url.pathname==='/seller/auth/callback'&&request.method==='GET'){requireAdminRole(session.role);return handleSellerOAuthCallback(env,url);}
      if(url.pathname.startsWith('/api/'))return await routeApi(request,env,url,session);
      return assetResponse(request,env);
    }catch(error){const status=error instanceof HttpError?error.status:500;return json({ok:false,error:error instanceof Error?error.message:String(error)},status);}
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    const now=new Date();const localHour=hourInTimezone(now,env.TIMEZONE);const localDate=dateInTimezone(now,env.TIMEZONE);
    const localParts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:env.TIMEZONE,hour:'2-digit',minute:'2-digit',hour12:false})
      .formatToParts(now).map((part)=>[part.type,part.value]));
    const localMinute=Number(localParts.minute);const slotTime=`${String(localHour).padStart(2,'0')}:${String(localMinute).padStart(2,'0')}`;
    ctx.waitUntil(pollOperationsInbox(env).catch((error)=>console.error('Operations bot polling failed',error instanceof Error?error.message:String(error))));
    if(env.ZALO_ORDER_BOT_TOKEN&&env.ZALO_ORDER_GROUP_CHAT_ID&&ORDER_BOT_SLOTS[slotTime])
      ctx.waitUntil(env.TASK_QUEUE.send({type:'order-bot-report',reportDate:localDate,reportTime:slotTime}));
    if(env.ZALO_ORDER_BOT_TOKEN&&env.ZALO_ORDER_GROUP_CHAT_ID&&localMinute%5===0)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'order-bot-monitor',reportDate:localDate}));
    if(localHour===8&&localMinute===5&&env.ZALO_OPERATIONS_BOT_TOKEN&&env.ZALO_OPERATIONS_GROUP_CHAT_ID){
      const yesterday=shiftDate(localDate,-1);
      ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-daily-report',reportDate:yesterday,operationsDate:yesterday,mode:'DAILY'}));
    }
    const localWeekday=new Date(`${localDate}T00:00:00Z`).getUTCDay();
    if(localWeekday===6&&localHour===10&&localMinute===30&&env.ZALO_OPERATIONS_BOT_TOKEN&&env.ZALO_OPERATIONS_GROUP_CHAT_ID)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-weekly-prepare',saturdayDate:localDate,stage:0}));
    if(localDate.endsWith('-01')&&localHour===10&&localMinute===35&&env.ZALO_OPERATIONS_BOT_TOKEN&&env.ZALO_OPERATIONS_GROUP_CHAT_ID)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-monthly-prepare',firstDayOfMonth:localDate,stage:0}));
    if(localMinute!==0)return;
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
        if(message.body.type==='operations-daily-report'&&message.body.eventId){
          await env.DB.prepare("UPDATE operations_bot_events SET status='RETRYING' WHERE external_id=?")
            .bind(message.body.eventId).run();
        }
        message.retry({delaySeconds:message.body.type==='tracking-sync'?60:10});
      }
    }
  }
} satisfies ExportedHandler<Env,TaskMessage>;
